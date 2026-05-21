/**
 * Gemini CLI Plugin for Opencode — Hybrid Mode.
 *
 * Uses the FASTEST available path for each request:
 * - Simple chat → gemini -p (subprocess, ~10s)
 * - Complex (tools/thinking) → HTTP Code Assist API (~60s)
 *
 * Both paths are 100% ToS compliant: tokens from CLI store,
 * no hardcoded credentials, no impersonation.
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
import { runGeminiPrompt } from "./gemini-fast";
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
const GEMINI_QUOTA_COMMAND_TEMPLATE = `Retrieve Gemini Code Assist quota usage.
Immediately call \`${GEMINI_QUOTA_TOOL_NAME}\` with no arguments and return its output verbatim.`;
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
      "\n[Gemini] CLI not found. Install: npm install -g @google/gemini-cli\nThen: gemini auth login\n",
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
            if (!isGenerativeLanguageRequest(input))
              return geminiFetch(input, init);

            const latestAuth = await getAuth();
            if (!isOAuthAuth(latestAuth)) return geminiFetch(input, init);
            let authRecord = resolveCachedAuth(latestAuth);
            if (accessTokenExpired(authRecord)) {
              const refreshed = await refreshAccessToken(authRecord, client);
              if (!refreshed) return geminiFetch(input, init);
              authRecord = refreshed;
            }
            if (!authRecord.access) return geminiFetch(input, init);

            const accessToken = authRecord.access;
            const configuredProjectId =
              await resolveLatestConfiguredProjectId(provider);
            const requestTarget = parseGenerativeLanguageRequest(input);
            const requestUserAgentModel = requestTarget?.effectiveModel;
            if (requestUserAgentModel)
              latestGeminiUserAgentModel = requestUserAgentModel;

            // ─── Hybrid dispatch ───────────────────────────────
            // Check if the request needs the full HTTP pipeline
            const body = typeof init?.body === "string" ? init.body : "";
            const needsFullPipeline = hasToolCallsOrThinking(body);

            if (!needsFullPipeline && cliAuthenticated) {
              // Simple chat → use fast gemini -p subprocess
              try {
                const { userText, systemText } = extractSimpleChat(body);
                if (userText) {
                  const result = await runGeminiPrompt(userText, {
                    model: requestUserAgentModel,
                    systemPrompt: systemText || undefined,
                  });
                  if (result.text) return buildSseResponse(result.text);
                }
              } catch {
                /* fall through to HTTP pipeline */
              }
            }

            // Complex request or fast path failed → full HTTP Code Assist pipeline
            try {
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
            } catch (err) {
              console.error("[Gemini] HTTP pipeline error:", err);
              return geminiFetch(input, init);
            }
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

// ─── Hybrid helpers ────────────────────────────────────────────

function hasToolCallsOrThinking(body: string): boolean {
  if (!body) return true; // can't determine, use full pipeline
  try {
    const p = JSON.parse(body);
    const req = p.request || p;
    // Check for tool definitions
    if (req.tools && Array.isArray(req.tools) && req.tools.length > 0)
      return true;
    if (req.tool_config) return true;
    // Check for thinking config
    if (req.generationConfig?.thinkingConfig) return true;
    if (req.thinkingConfig) return true;
    return false;
  } catch {
    return true;
  }
}

function extractSimpleChat(body: string): {
  userText: string;
  systemText?: string;
} {
  if (!body) return { userText: "" };
  try {
    const p = JSON.parse(body);
    const req = p.request || p;
    const contents = req.contents;
    if (!Array.isArray(contents) || contents.length === 0)
      return { userText: "" };

    let systemText: string | undefined;
    const si = req.systemInstruction;
    if (si?.parts && Array.isArray(si.parts)) {
      systemText = si.parts
        .filter((p: any) => p?.text)
        .map((p: any) => p.text)
        .join("\n");
    }

    let userText = "";
    for (let i = contents.length - 1; i >= 0; i--) {
      const c = contents[i];
      if (!c || typeof c !== "object" || c.role !== "user") continue;
      const parts = c.parts;
      if (!Array.isArray(parts)) continue;
      const texts = parts.filter((p: any) => p?.text).map((p: any) => p.text);
      if (texts.length > 0) {
        userText = texts.join("\n");
        break;
      }
    }
    return { userText, systemText };
  } catch {
    return { userText: "" };
  }
}

function buildSseResponse(text: string): Response {
  const encoder = new TextEncoder();
  const data = JSON.stringify({
    candidates: [
      {
        content: { parts: [{ text }], role: "model" },
        finishReason: "STOP",
        safetyRatings: [],
      },
    ],
  });
  return new Response(encoder.encode(`data: ${data}\n\ndata: [DONE]\n\n`), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

// ─── Original helpers (unchanged) ─────────────────────────────

function normalizeProviderModelCosts(provider: Provider): void {
  if (!provider?.models || typeof provider.models !== "object") return;
  for (const [, model] of Object.entries(provider.models)) {
    if (!model || typeof model !== "object") continue;
    const ec = model.cost;
    const ok =
      ec &&
      typeof ec === "object" &&
      typeof ec.input === "number" &&
      typeof ec.output === "number";
    model.cost = {
      input: ok ? ec.input : 0,
      output: ok ? ec.output : 0,
      cache: {
        read:
          ok && ec.cache && typeof (ec.cache as any).read === "number"
            ? (ec.cache as any).read
            : 0,
        write:
          ok && ec.cache && typeof (ec.cache as any).write === "number"
            ? (ec.cache as any).write
            : 0,
      },
    };
  }
}

function resolveThinkingConfigDefaults(
  provider: Provider,
): ThinkingConfigDefaults | undefined {
  const po =
    provider && typeof provider === "object"
      ? ((provider as any).options ?? undefined)
      : undefined;
  const pConf = po?.thinkingConfig;
  const mConf: Record<string, unknown> = {};
  for (const [id, model] of Object.entries(provider.models ?? {})) {
    if (!model || typeof model !== "object") continue;
    const mo = (model as any).options;
    if (mo && typeof mo === "object" && "thinkingConfig" in mo)
      mConf[id] = mo.thinkingConfig;
  }
  if (pConf === undefined && Object.keys(mConf).length === 0) return undefined;
  return { provider: pConf, models: mConf };
}

async function ensureProjectContextOrThrow(
  auth: OAuthAuthDetails,
  c: PluginClient,
  pid?: string,
  ua?: string,
) {
  try {
    return await ensureProjectContext(auth, c, pid, ua);
  } catch (e) {
    if (e instanceof Error) console.error(e.message);
    throw e;
  }
}

function toUrlString(v: RequestInfo): string {
  if (typeof v === "string") return v;
  const c = (v as Request).url;
  if (c) return c;
  return v.toString();
}

export { toRequestUrlString } from "./plugin/request/shared";
