import { generatePKCE } from "@openauthjs/openauth/pkce";
import { randomBytes } from "node:crypto";

import { GEMINI_REDIRECT_URI, GEMINI_SCOPES } from "../constants";
import { readGeminiAppCredentials } from "../gemini-cli";
import {
  formatDebugBodyPreview,
  isGeminiDebugEnabled,
  logGeminiDebugMessage,
} from "../plugin/debug";
import { geminiFetch } from "../fetch";

interface PkcePair {
  challenge: string;
  verifier: string;
}

/**
 * Result returned to the caller after constructing an OAuth authorization URL.
 */
export interface GeminiAuthorization {
  url: string;
  verifier: string;
  state: string;
}

interface GeminiTokenExchangeSuccess {
  type: "success";
  refresh: string;
  access: string;
  expires: number;
  email?: string;
}

interface GeminiTokenExchangeFailure {
  type: "failed";
  error: string;
}

export type GeminiTokenExchangeResult =
  | GeminiTokenExchangeSuccess
  | GeminiTokenExchangeFailure;

interface GeminiTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
}

interface GeminiUserInfo {
  email?: string;
}

/**
 * Resolves the OAuth app credentials, preferring the Gemini CLI bundle
 * and falling back to a known set (which are only read at runtime from
 * the user's locally installed CLI).
 */
function resolveOAuthCredentials(): {
  clientId: string;
  clientSecret: string;
} {
  const appCreds = readGeminiAppCredentials();
  if (appCreds) {
    return {
      clientId: appCreds.clientId,
      clientSecret: appCreds.clientSecret,
    };
  }

  // If the CLI isn't installed, tell the user
  throw new Error(
    "Gemini CLI is not installed. Run `npm install -g @google/gemini-cli` to install it, then authenticate with `gemini auth login`.",
  );
}

/**
 * Build the Gemini OAuth authorization URL including PKCE.
 * Uses credentials from the locally installed Gemini CLI.
 */
export async function authorizeGemini(): Promise<GeminiAuthorization> {
  const { clientId } = resolveOAuthCredentials();
  const pkce = (await generatePKCE()) as PkcePair;
  const state = randomBytes(32).toString("hex");

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", GEMINI_REDIRECT_URI);
  url.searchParams.set("scope", GEMINI_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  // Add a fragment so any stray terminal glyphs are ignored by the auth server.
  url.hash = "opencode";

  return {
    url: url.toString(),
    verifier: pkce.verifier,
    state,
  };
}

/**
 * Exchange an authorization code using a known PKCE verifier.
 */
export async function exchangeGeminiWithVerifier(
  code: string,
  verifier: string,
): Promise<GeminiTokenExchangeResult> {
  try {
    return await exchangeGeminiWithVerifierInternal(code, verifier);
  } catch (error) {
    return {
      type: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function exchangeGeminiWithVerifierInternal(
  code: string,
  verifier: string,
): Promise<GeminiTokenExchangeResult> {
  const { clientId, clientSecret } = resolveOAuthCredentials();

  if (isGeminiDebugEnabled()) {
    logGeminiDebugMessage(
      "OAuth exchange: POST https://oauth2.googleapis.com/token",
    );
  }
  const tokenResponse = await geminiFetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: GEMINI_REDIRECT_URI,
        code_verifier: verifier,
      }),
    },
  );

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    if (isGeminiDebugEnabled()) {
      logGeminiDebugMessage(
        `OAuth exchange response: ${tokenResponse.status} ${tokenResponse.statusText}`,
      );
      const preview = formatDebugBodyPreview(errorText);
      if (preview) {
        logGeminiDebugMessage(`OAuth exchange error body: ${preview}`);
      }
    }
    return { type: "failed", error: errorText };
  }

  const tokenPayload = (await tokenResponse.json()) as GeminiTokenResponse;
  if (isGeminiDebugEnabled()) {
    logGeminiDebugMessage(
      `OAuth exchange success: expires_in=${tokenPayload.expires_in}s refresh_token=${tokenPayload.refresh_token ? "yes" : "no"}`,
    );
  }

  if (isGeminiDebugEnabled()) {
    logGeminiDebugMessage(
      "OAuth userinfo: GET https://www.googleapis.com/oauth2/v1/userinfo",
    );
  }
  const userInfoResponse = await geminiFetch(
    "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
    {
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`,
      },
    },
  );
  if (isGeminiDebugEnabled()) {
    logGeminiDebugMessage(
      `OAuth userinfo response: ${userInfoResponse.status} ${userInfoResponse.statusText}`,
    );
  }

  const userInfo = userInfoResponse.ok
    ? ((await userInfoResponse.json()) as GeminiUserInfo)
    : {};

  const refreshToken = tokenPayload.refresh_token;
  if (!refreshToken) {
    return { type: "failed", error: "Missing refresh token in response" };
  }

  return {
    type: "success",
    refresh: refreshToken,
    access: tokenPayload.access_token,
    expires: Date.now() + tokenPayload.expires_in * 1000,
    email: userInfo.email,
  };
}
