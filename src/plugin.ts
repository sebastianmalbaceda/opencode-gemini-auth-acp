/**
 * Gemini CLI ACP Plugin for Opencode.
 *
 * Architecture:
 *   Opencode → Plugin → ACP (JSON-RPC stdio) → gemini --acp → Google APIs
 */

import { GEMINI_PROVIDER_ID } from "./constants";
import { isGeminiCliInstalled, isGeminiAuthenticated } from "./gemini-cli";
import { geminiFetch } from "./fetch";
import { createOAuthAuthorizeMethod } from "./plugin/oauth-authorize";
import { accessTokenExpired, isOAuthAuth } from "./plugin/auth";
import { resolveCachedAuth } from "./plugin/cache";
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
  PluginContext,
  PluginResult,
  Provider,
} from "./plugin/types";

const GEMINI_QUOTA_COMMAND = "gquota";
const GEMINI_QUOTA_COMMAND_TEMPLATE = `Retrieve Gemini Code Assist quota usage.

Immediately call \`${GEMINI_QUOTA_TOOL_NAME}\` with no arguments and return its output verbatim.`;
let latestGeminiAuthResolver: GetAuth | undefined;
let latestGeminiConfiguredProjectId: string | undefined;

// ─── Module-level ACP singleton ──────────────────────────────
let acpClientPromise: Promise<AcpClient> | null = null;
let acpClient: AcpClient | null = null;
let acpSessionId: string | null = null;

async function getAcp(): Promise<{ client: AcpClient; sessionId: string }> {
  if (acpClient && acpSessionId && acpClient.isConnected) {
    return { client: acpClient, sessionId: acpSessionId };
  }
  if (!acpClientPromise) {
    acpClientPromise = initAcp();
  }
  const c = await acpClientPromise;
  return { client: c, sessionId: acpSessionId! };
}

async function initAcp(): Promise<AcpClient> {
  logGeminiDebugMessage("ACP: connecting...");
  const c = await AcpClient.create();
  const info = await c.initialize();
  logGeminiDebugMessage(
    `ACP: ${info.agentInfo.name} v${info.agentInfo.version}`,
  );
  await c.authenticate();
  const sid = await c.createSession(process.cwd());
  logGeminiDebugMessage(`ACP session: ${sid}`);
  acpClient = c;
  acpSessionId = sid;
  return c;
}

function resetAcp(): void {
  const p = acpClientPromise;
  acpClientPromise = null;
  acpClient = null;
  acpSessionId = null;
  if (p) p.then((c) => c.destroy().catch(() => {})).catch(() => {});
}

// ─── Plugin ──────────────────────────────────────────────────

export const GeminiCLIOAuthPlugin = async ({
  client,
}: PluginContext): Promise<PluginResult> => {
  const cliInstalled = isGeminiCliInstalled();
  const cliAuthenticated = cliInstalled && isGeminiAuthenticated();

  if (!cliInstalled) {
    console.warn(
      "\n[Gemini] CLI not found. Install: npm install -g @google/gemini-cli",
    );
  } else if (!cliAuthenticated) {
    console.warn("\n[Gemini] CLI not authenticated. Run: gemini auth login");
  } else if (isGeminiDebugEnabled()) {
    logGeminiDebugMessage("Gemini CLI detected and authenticated.");
  }

  const resolveLatestConfiguredProjectId = async (provider?: Provider) => {
    const configProjectId =
      (await resolveConfiguredProjectIdFromClient(client)) ??
      latestGeminiConfiguredProjectId;
    const resolved = resolveConfiguredProjectId({ provider, configProjectId });
    latestGeminiConfiguredProjectId = resolved;
    return resolved;
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
        if (!isOAuthAuth(auth)) return null;

        await resolveLatestConfiguredProjectId(provider);
        normalizeProviderModelCosts(provider);

        return {
          apiKey: "",
          async fetch(input, init) {
            try {
              return await acpFetch(input, init, getAuth, client);
            } catch {
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

// ─── ACP Fetch Handler ──────────────────────────────────────

async function acpFetch(
  input: RequestInfo,
  init: RequestInit | undefined,
  getAuth: GetAuth,
  client: PluginContext["client"],
): Promise<Response> {
  if (!isGenerativeLanguageRequest(input)) return geminiFetch(input, init);

  // Auth
  const authLatest = await getAuth();
  if (!isOAuthAuth(authLatest)) return geminiFetch(input, init);
  let ar = resolveCachedAuth(authLatest);
  if (accessTokenExpired(ar)) {
    const ref = await refreshAccessToken(ar, client);
    if (!ref?.access) return geminiFetch(input, init);
    ar = ref;
  }

  // Extract user text from body
  const raw = typeof init?.body === "string" ? init.body : "";
  const { userText, systemText } = parseGeminiRequest(raw);
  if (!userText) return geminiFetch(input, init);

  // ACP call
  try {
    const { client: acp, sessionId } = await getAcp();
    let fullText = "";
    const result = await acp.sendPrompt(sessionId, userText, {
      onChunk: (chunk) => {
        fullText += chunk;
      },
      systemPrompt: systemText,
    });

    const out = result.text || fullText;
    if (!out) return geminiFetch(input, init);

    return buildSseResponse(out, result);
  } catch (err) {
    console.error("[Gemini ACP] Error:", err);
    resetAcp();
    return geminiFetch(input, init);
  }
}

// ─── Response Builder ───────────────────────────────────────

function buildSseResponse(
  text: string,
  result: {
    stopReason?: string;
    usage?: {
      totalTokens?: number;
      promptTokens?: number;
      completionTokens?: number;
    };
  },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const data = JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text }], role: "model" },
            finishReason: result.stopReason || "STOP",
            safetyRatings: [],
          },
        ],
        usageMetadata: result.usage
          ? {
              promptTokenCount: result.usage.promptTokens ?? 0,
              candidatesTokenCount: result.usage.completionTokens ?? 0,
              totalTokenCount: result.usage.totalTokens ?? 0,
            }
          : undefined,
      });
      controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

// ─── Request Parser ─────────────────────────────────────────

function parseGeminiRequest(body: string): {
  userText: string;
  systemText?: string;
} {
  if (!body) return { userText: "" };
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const req = (parsed.request as Record<string, unknown>) ?? parsed;
    const contents = req.contents as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(contents) || contents.length === 0)
      return { userText: "" };

    // System instruction
    let systemText: string | undefined;
    const si = req.systemInstruction as Record<string, unknown> | undefined;
    if (si?.parts && Array.isArray(si.parts)) {
      systemText = si.parts
        .filter(
          (p: unknown) =>
            typeof p === "object" && (p as Record<string, unknown>).text,
        )
        .map((p: unknown) => (p as Record<string, unknown>).text as string)
        .join("\n");
    }

    // Last user message
    let userText = "";
    for (let i = contents.length - 1; i >= 0; i--) {
      const c = contents[i];
      if (!c || typeof c !== "object" || c.role !== "user") continue;
      const parts = c.parts as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(parts)) continue;
      const texts = parts.filter((p) => p?.text).map((p) => p.text as string);
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

function normalizeProviderModelCosts(provider: Provider): void {
  if (!provider?.models) return;
  for (const m of Object.values(provider.models)) {
    if (!m || typeof m !== "object") continue;
    const ec = m.cost;
    const ok =
      ec &&
      typeof ec === "object" &&
      typeof ec.input === "number" &&
      typeof ec.output === "number";
    const cacheRead =
      ok && ec.cache && typeof (ec.cache as { read?: number }).read === "number"
        ? (ec.cache as { read: number }).read
        : 0;
    const cacheWrite =
      ok &&
      ec.cache &&
      typeof (ec.cache as { write?: number }).write === "number"
        ? (ec.cache as { write: number }).write
        : 0;
    m.cost = {
      input: ok ? ec.input : 0,
      output: ok ? ec.output : 0,
      cache: { read: cacheRead, write: cacheWrite },
    };
  }
}

export {
  toRequestUrlString,
  injectResponseIdFromTrace,
} from "./plugin/request/shared";
