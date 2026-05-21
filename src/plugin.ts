/**
 * Gemini CLI Plugin for Opencode.
 *
 * Uses `gemini -p` (CLI prompt mode) for all generative requests.
 * The CLI handles authentication, token refresh, and API calls.
 * The plugin simply bridges Opencode's requests to the CLI.
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
import { runGeminiPrompt } from "./gemini-run";
import type {
  GetAuth,
  LoaderResult,
  PluginContext,
  PluginResult,
  Provider,
} from "./plugin/types";

const GEMINI_QUOTA_COMMAND = "gquota";
const GEMINI_QUOTA_COMMAND_TEMPLATE = `Retrieve Gemini Code Assist quota usage. Immediately call \`${GEMINI_QUOTA_TOOL_NAME}\` with no arguments.`;
let latestGeminiAuthResolver: GetAuth | undefined;
let latestGeminiConfiguredProjectId: string | undefined;

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
            // Non-generative requests pass through
            if (!isGenerativeLanguageRequest(input)) {
              return geminiFetch(input, init);
            }
            // All generative requests go through the CLI
            return cliFetch(input, init, getAuth, client);
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

// ─── CLI Fetch ──────────────────────────────────────────────

async function cliFetch(
  input: RequestInfo,
  init: RequestInit | undefined,
  getAuth: GetAuth,
  client: PluginContext["client"],
): Promise<Response> {
  // Ensure valid auth
  const authLatest = await getAuth();
  if (!isOAuthAuth(authLatest)) {
    return new Response("Not authenticated. Run `opencode auth login`.", {
      status: 401,
    });
  }
  let ar = resolveCachedAuth(authLatest);
  if (accessTokenExpired(ar)) {
    const ref = await refreshAccessToken(ar, client);
    if (!ref?.access) {
      return new Response("Session expired. Run `gemini auth login`.", {
        status: 401,
      });
    }
    ar = ref;
  }

  // Extract user text and model from the request
  const raw = typeof init?.body === "string" ? init.body : "";
  const { userText, systemText, model } = parseRequest(raw);
  if (!userText) {
    return geminiFetch(input, init);
  }

  // Run via the Gemini CLI
  try {
    const result = await runGeminiPrompt(userText, {
      model: model || undefined,
      systemPrompt: systemText || undefined,
    });

    if (!result.text) {
      throw new Error("Empty response from Gemini CLI");
    }

    return buildSseResponse(result.text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Gemini CLI] Error:", msg);
    return new Response(`Gemini error: ${msg}`, { status: 502 });
  }
}

// ─── Response Builder ───────────────────────────────────────

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

// ─── Request Parser ─────────────────────────────────────────

function parseRequest(body: string): {
  userText: string;
  systemText?: string;
  model?: string;
} {
  if (!body) return { userText: "" };
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const req = (parsed.request as Record<string, unknown>) ?? parsed;
    const contents = req.contents as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(contents) || contents.length === 0)
      return { userText: "" };

    // Model
    const model =
      typeof parsed.model === "string"
        ? parsed.model
        : typeof req.model === "string"
          ? req.model
          : undefined;

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

    return { userText, systemText, model };
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
