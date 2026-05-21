/**
 * Gemini CLI ACP Plugin for Opencode.
 *
 * This plugin integrates the Gemini CLI via ACP (Agent Communication Protocol),
 * replacing the previous direct HTTP calls to internal Code Assist APIs.
 *
 * Architecture:
 *   Opencode → Plugin → ACP Client (JSON-RPC over stdio) → gemini --acp → Google APIs
 *
 * The Gemini CLI handles all authentication and API calls. The plugin
 * simply bridges Opencode's requests to the ACP protocol and vice versa.
 */

import { GEMINI_PROVIDER_ID } from "./constants";
import { isGeminiCliInstalled, isGeminiAuthenticated } from "./gemini-cli";
import { geminiFetch } from "./fetch";
import { createOAuthAuthorizeMethod } from "./plugin/oauth-authorize";
import { accessTokenExpired, isOAuthAuth } from "./plugin/auth";
import { resolveCachedAuth } from "./plugin/cache";
import { retrieveUserQuota } from "./plugin/project";
import { createGeminiQuotaTool, GEMINI_QUOTA_TOOL_NAME } from "./plugin/quota";
import { isGeminiDebugEnabled, logGeminiDebugMessage } from "./plugin/debug";
import {
  resolveConfiguredProjectId,
  resolveConfiguredProjectIdFromClient,
  resolveConfiguredProjectIdFromConfig,
} from "./plugin/provider";
import { isGenerativeLanguageRequest } from "./plugin/request/shared";
import { refreshAccessToken } from "./plugin/token";
import { AcpClient } from "./acp";
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

/**
 * Registers the Gemini ACP provider for Opencode.
 */
export const GeminiCLIOAuthPlugin = async ({
  client,
}: PluginContext): Promise<PluginResult> => {
  // Fast CLI detection
  const cliInstalled = isGeminiCliInstalled();
  const cliAuthenticated = cliInstalled && isGeminiAuthenticated();

  if (!cliInstalled) {
    console.warn(
      "\n[Gemini Plugin] The Gemini CLI is not installed. " +
        "Install it globally with: npm install -g @google/gemini-cli\n" +
        "Then authenticate with: gemini auth login\n" +
        "After that, restart Opencode.\n",
    );
  } else if (!cliAuthenticated) {
    console.warn(
      "\n[Gemini Plugin] Gemini CLI is installed but not authenticated.\n" +
        "Run `gemini auth login` in your terminal, then restart Opencode.\n" +
        "Alternatively, proceed with browser-based OAuth below.\n",
    );
  } else if (isGeminiDebugEnabled()) {
    logGeminiDebugMessage("Gemini CLI detected and authenticated.");
  }

  // ─── ACP client (lazy init) ───────────────────────────────
  let acpClient: AcpClient | null = null;
  let acpSessionId: string | null = null;
  let acpInitialized = false;

  async function ensureAcpConnection(): Promise<{
    client: AcpClient;
    sessionId: string;
  }> {
    if (acpClient && acpSessionId && acpClient.isConnected) {
      return { client: acpClient, sessionId: acpSessionId };
    }

    if (acpClient) {
      await acpClient.destroy().catch(() => {});
    }

    logGeminiDebugMessage("Starting ACP connection to gemini --acp...");
    const client_ = await AcpClient.create();
    const info = await client_.initialize();
    logGeminiDebugMessage(
      `ACP connected: ${info.agentInfo.name} v${info.agentInfo.version}`,
    );
    await client_.authenticate();
    const sessionId = await client_.createSession(process.cwd());
    logGeminiDebugMessage(`ACP session created: ${sessionId}`);

    acpClient = client_;
    acpSessionId = sessionId;
    acpInitialized = true;
    return { client: client_, sessionId };
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
        getUserAgentModel: () => undefined,
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
        if (!isOAuthAuth(auth)) {
          return null;
        }

        await resolveLatestConfiguredProjectId(provider);
        normalizeProviderModelCosts(provider);

        return {
          apiKey: "",
          async fetch(input, init) {
            if (!isGenerativeLanguageRequest(input)) {
              return geminiFetch(input, init);
            }

            // Ensure auth
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

            // ─── Extract user message from the Gemini request ───
            const body = typeof init?.body === "string" ? init.body : "";
            const text = extractUserMessageFromRequestBody(body);

            if (!text) {
              return geminiFetch(input, init);
            }

            try {
              // Connect to ACP (reuses existing connection)
              const { client: acp, sessionId } = await ensureAcpConnection();

              // Stream via ACP
              let collectedText = "";
              const result = await acp.sendPrompt(sessionId, text, {
                onChunk: (chunk: string) => {
                  collectedText += chunk;
                },
              });

              // Build HTTP response for Opencode
              const responseBody = buildOpenaiChunk(
                result.text || collectedText,
              );
              const headers = new Headers({
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              });

              return new Response(responseBody, {
                status: 200,
                statusText: "OK",
                headers,
              });
            } catch (error) {
              console.error("[Gemini ACP] Prompt failed:", error);
              // Fallback: use HTTP pipeline
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

// ─── Helpers ─────────────────────────────────────────────────────

function normalizeProviderModelCosts(provider: Provider): void {
  if (!provider?.models || typeof provider.models !== "object") {
    return;
  }
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

/**
 * Extracts user message text from a Gemini API request body.
 * Handles both wrapped (Code Assist) and unwrapped (direct) formats.
 */
function extractUserMessageFromRequestBody(body: string): string {
  if (!body) return "";

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;

    // Wrapped Code Assist format: { project, model, request: { contents: [...] } }
    const requestData = parsed.request as Record<string, unknown> | undefined;
    const contents = (requestData?.contents ?? parsed.contents) as
      | Array<Record<string, unknown>>
      | undefined;

    if (!Array.isArray(contents) || contents.length === 0) {
      // If no contents, try to use the body itself
      return "";
    }

    // Collect all user text from contents
    const textParts: string[] = [];
    for (const content of contents) {
      if (!content || typeof content !== "object") continue;
      const role = content.role as string | undefined;
      const parts = content.parts as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(parts)) continue;

      for (const part of parts) {
        if (part?.text && typeof part.text === "string") {
          textParts.push(part.text);
        }
      }
    }

    return textParts.join("\n");
  } catch {
    return "";
  }
}

/**
 * Builds a minimal OpenAI-style SSE chunk for streaming responses.
 */
function buildOpenaiChunk(text: string): string {
  const lines: string[] = [];
  for (const char of text) {
    const payload = JSON.stringify({
      choices: [
        {
          delta: { content: char },
          index: 0,
        },
      ],
    });
    lines.push(`data: ${payload}\n`);
  }
  lines.push("data: [DONE]\n");
  return lines.join("");
}

// Backward compatibility re-exports
export {
  toRequestUrlString,
  injectResponseIdFromTrace,
} from "./plugin/request/shared";
