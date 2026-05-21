/**
 * Gemini CLI Plugin for Opencode.
 *
 * Architecture:
 *   Opencode → Plugin → HTTP (Code Assist API) with tokens from Gemini CLI
 *
 * The CLI handles authentication (gemini auth login).
 * The plugin reads tokens from the CLI's credential store and uses them
 * to make direct HTTP calls to the Gemini Code Assist API.
 *
 * This approach supports streaming, tool calls, thinking config, and
 * multi-turn conversations — identical to the original plugin, but
 * without hardcoded OAuth credentials or user-agent impersonation.
 */

import { GEMINI_PROVIDER_ID } from "./constants";
import { isGeminiCliInstalled, isGeminiAuthenticated } from "./gemini-cli";
import { geminiFetch } from "./fetch";
import { createOAuthAuthorizeMethod } from "./plugin/oauth-authorize";
import { accessTokenExpired, isOAuthAuth } from "./plugin/auth";
import { resolveCachedAuth } from "./plugin/cache";
import { ensureProjectContext, retrieveUserQuota } from "./plugin/project";
import { createGeminiQuotaTool, GEMINI_QUOTA_TOOL_NAME } from "./plugin/quota";
import {
  isGeminiDebugEnabled,
  logGeminiDebugMessage,
  startGeminiDebugRequest,
} from "./plugin/debug";
import {
  maybeShowGeminiCapacityToast,
  maybeShowGeminiTestToast,
} from "./plugin/notify";
import {
  resolveConfiguredProjectId,
  resolveConfiguredProjectIdFromClient,
  resolveConfiguredProjectIdFromConfig,
} from "./plugin/provider";
import {
  isGenerativeLanguageRequest,
  parseGenerativeLanguageRequest,
  prepareGeminiRequest,
  type ThinkingConfigDefaults,
  transformGeminiResponse,
} from "./plugin/request";
import { fetchWithRetry } from "./plugin/retry";
import { refreshAccessToken } from "./plugin/token";
import type {
  GetAuth,
  LoaderResult,
  OAuthAuthDetails,
  PluginClient,
  PluginContext,
  PluginResult,
  Provider,
} from "./plugin/types";

const GEMINI_QUOTA_COMMAND = "gquota";
const GEMINI_QUOTA_COMMAND_TEMPLATE = `Retrieve Gemini Code Assist quota usage for the current authenticated account.

Immediately call \`${GEMINI_QUOTA_TOOL_NAME}\` with no arguments and return its output verbatim.
Do not call other tools.
`;
let latestGeminiAuthResolver: GetAuth | undefined;
let latestGeminiConfiguredProjectId: string | undefined;
let latestGeminiUserAgentModel: string | undefined;

export const GeminiCLIOAuthPlugin = async ({
  client,
}: PluginContext): Promise<PluginResult> => {
  const cliInstalled = isGeminiCliInstalled();
  const cliAuthenticated = cliInstalled && isGeminiAuthenticated();

  if (!cliInstalled) {
    console.warn(
      "\n[Gemini] CLI not found. Install: npm install -g @google/gemini-cli\n" +
        "Then authenticate: gemini auth login\n",
    );
  } else if (!cliAuthenticated) {
    console.warn("\n[Gemini] CLI not authenticated. Run: gemini auth login\n");
  } else if (isGeminiDebugEnabled()) {
    logGeminiDebugMessage("Gemini CLI detected and authenticated.");
  }

  const resolveLatestConfiguredProjectId = async (
    provider?: Provider,
  ): Promise<string | undefined> => {
    const configProjectId =
      (await resolveConfiguredProjectIdFromClient(client)) ??
      latestGeminiConfiguredProjectId;
    const resolvedProjectId = resolveConfiguredProjectId({
      provider,
      configProjectId,
    });
    latestGeminiConfiguredProjectId = resolvedProjectId;
    return resolvedProjectId;
  };

  return {
    config: async (config) => {
      latestGeminiConfiguredProjectId =
        resolveConfiguredProjectIdFromConfig(config);
      config.command = config.command || {};
      config.command[GEMINI_QUOTA_COMMAND] = {
        description: "Show Gemini Code Assist quota usage",
        template: GEMINI_QUOTA_COMMAND_TEMPLATE,
      };
    },
    tool: {
      [GEMINI_QUOTA_TOOL_NAME]: createGeminiQuotaTool({
        client,
        getAuthResolver: () => latestGeminiAuthResolver,
        getConfiguredProjectId: () => latestGeminiConfiguredProjectId,
        getUserAgentModel: () => latestGeminiUserAgentModel,
      }),
    },
    auth: {
      provider: GEMINI_PROVIDER_ID,
      loader: async (
        getAuth: GetAuth,
        provider: Provider,
      ): Promise<LoaderResult | null> => {
        latestGeminiAuthResolver = getAuth;
        const auth = await getAuth();
        if (!isOAuthAuth(auth)) return null;

        await resolveLatestConfiguredProjectId(provider);
        normalizeProviderModelCosts(provider);
        const thinkingConfigDefaults = resolveThinkingConfigDefaults(provider);

        return {
          apiKey: "",
          async fetch(input, init) {
            if (!isGenerativeLanguageRequest(input)) {
              return geminiFetch(input, init);
            }

            const latestAuth = await getAuth();
            if (!isOAuthAuth(latestAuth)) {
              return geminiFetch(input, init);
            }

            let authRecord = resolveCachedAuth(latestAuth);
            if (accessTokenExpired(authRecord)) {
              const refreshed = await refreshAccessToken(authRecord, client);
              if (!refreshed) {
                return geminiFetch(input, init);
              }
              authRecord = refreshed;
            }

            if (!authRecord.access) {
              return geminiFetch(input, init);
            }

            const accessToken = authRecord.access;
            const configuredProjectId =
              await resolveLatestConfiguredProjectId(provider);
            const requestTarget = parseGenerativeLanguageRequest(input);
            const requestUserAgentModel = requestTarget?.effectiveModel;
            if (requestUserAgentModel) {
              latestGeminiUserAgentModel = requestUserAgentModel;
            }

            // Resolve project context (cached)
            const projectContext = await ensureProjectContextOrThrow(
              authRecord,
              client,
              configuredProjectId,
              requestUserAgentModel,
            );

            await maybeShowGeminiTestToast(
              client,
              projectContext.effectiveProjectId,
            );

            // Transform and send the request via HTTP to Code Assist API
            const transformed = prepareGeminiRequest(
              input,
              init,
              accessToken,
              projectContext.effectiveProjectId,
              thinkingConfigDefaults,
            );

            const debugContext = startGeminiDebugRequest({
              originalUrl: toUrlString(input),
              resolvedUrl: toUrlString(transformed.request),
              method: transformed.init.method,
              headers: transformed.init.headers,
              body: transformed.init.body,
              streaming: transformed.streaming,
              projectId: projectContext.effectiveProjectId,
            });

            const response = await fetchWithRetry(
              transformed.request,
              transformed.init,
            );

            await maybeShowGeminiCapacityToast(
              client,
              response,
              projectContext.effectiveProjectId,
              transformed.requestedModel,
            );

            return transformGeminiResponse(
              response,
              transformed.streaming,
              debugContext,
              transformed.requestedModel,
            );
          },
        };
      },
      methods: [
        {
          label: "OAuth with Google (Gemini CLI)",
          type: "oauth",
          authorize: createOAuthAuthorizeMethod({
            getConfiguredProjectId: () => resolveLatestConfiguredProjectId(),
            getUserAgentModel: () => latestGeminiUserAgentModel,
          }),
        },
        {
          provider: GEMINI_PROVIDER_ID,
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  };
};

export const GoogleOAuthPlugin = GeminiCLIOAuthPlugin;
const loggedQuotaModelsByProject = new Set<string>();

function normalizeProviderModelCosts(provider: Provider): void {
  if (!provider?.models || typeof provider.models !== "object") return;
  for (const [modelId, model] of Object.entries(provider.models)) {
    if (!model || typeof model !== "object") continue;
    const existingCost = model.cost;
    const isValidCost =
      existingCost &&
      typeof existingCost === "object" &&
      typeof existingCost.input === "number" &&
      typeof existingCost.output === "number";
    const normalizedCost = {
      input: isValidCost ? existingCost.input : 0,
      output: isValidCost ? existingCost.output : 0,
      cache: {
        read:
          isValidCost &&
          typeof existingCost.cache === "object" &&
          existingCost.cache !== null &&
          typeof (existingCost.cache as { read?: number }).read === "number"
            ? (existingCost.cache as { read: number }).read
            : 0,
        write:
          isValidCost &&
          typeof existingCost.cache === "object" &&
          existingCost.cache !== null &&
          typeof (existingCost.cache as { write?: number }).write === "number"
            ? (existingCost.cache as { write: number }).write
            : 0,
      },
    };
    model.cost = normalizedCost;
  }
}

function resolveThinkingConfigDefaults(
  provider: Provider,
): ThinkingConfigDefaults | undefined {
  const providerOptions =
    provider && typeof provider === "object"
      ? ((provider as { options?: Record<string, unknown> }).options ??
        undefined)
      : undefined;
  const providerThinkingConfig = providerOptions?.thinkingConfig;
  const modelThinkingConfigByModel: Record<string, unknown> = {};
  for (const [modelId, model] of Object.entries(provider.models ?? {})) {
    if (!model || typeof model !== "object") continue;
    const modelOptions = (model as { options?: Record<string, unknown> })
      .options;
    if (
      modelOptions &&
      typeof modelOptions === "object" &&
      "thinkingConfig" in modelOptions
    ) {
      modelThinkingConfigByModel[modelId] = modelOptions.thinkingConfig;
    }
  }
  if (
    providerThinkingConfig === undefined &&
    Object.keys(modelThinkingConfigByModel).length === 0
  ) {
    return undefined;
  }
  return {
    provider: providerThinkingConfig,
    models: modelThinkingConfigByModel,
  };
}

async function ensureProjectContextOrThrow(
  authRecord: OAuthAuthDetails,
  client: PluginClient,
  configuredProjectId?: string,
  userAgentModel?: string,
) {
  try {
    return await ensureProjectContext(
      authRecord,
      client,
      configuredProjectId,
      userAgentModel,
    );
  } catch (error) {
    if (error instanceof Error) console.error(error.message);
    throw error;
  }
}

function toUrlString(value: RequestInfo): string {
  if (typeof value === "string") return value;
  const candidate = (value as Request).url;
  if (candidate) return candidate;
  return value.toString();
}

async function maybeLogAvailableQuotaModels(
  accessToken: string,
  projectId: string,
  userAgentModel?: string,
): Promise<void> {
  if (!isGeminiDebugEnabled() || !projectId) return;
  if (loggedQuotaModelsByProject.has(projectId)) return;
  loggedQuotaModelsByProject.add(projectId);
  const quota = await retrieveUserQuota(accessToken, projectId, userAgentModel);
  if (!quota?.buckets) {
    logGeminiDebugMessage(
      `Code Assist quota model lookup returned no buckets for project: ${projectId}`,
    );
    return;
  }
  const modelIds = [
    ...new Set(quota.buckets.map((bucket) => bucket.modelId).filter(Boolean)),
  ];
  if (modelIds.length === 0) {
    logGeminiDebugMessage(
      `Code Assist quota buckets contained no model IDs for project: ${projectId}`,
    );
    return;
  }
  logGeminiDebugMessage(
    `Code Assist models visible via quota buckets (${projectId}): ${modelIds.join(", ")}`,
  );
}

export { toRequestUrlString } from "./plugin/request/shared";
