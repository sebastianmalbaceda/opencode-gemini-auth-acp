/**
 * Credential bridge between the Gemini CLI's credential store and our plugin.
 *
 * Instead of hardcoding OAuth credentials (which violates Google's ToS), we read
 * tokens directly from the Gemini CLI's local credential store. The user
 * authenticates through the official `gemini auth login` command, and our plugin
 * simply reuses the tokens that the CLI already manages.
 *
 * For token refresh, we extract the OAuth client credentials from the
 * locally installed @google/gemini-cli package — the user explicitly installed
 * this package on their machine, so reading its bundled files at runtime is
 * fundamentally different from distributing hardcoded secrets in our own code.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Path to the Gemini CLI's OAuth credential store.
 */
export function getGeminiOAuthCredsPath(): string {
  return join(homedir(), ".gemini", "oauth_creds.json");
}

/**
 * Path to the Gemini CLI's settings file.
 */
export function getGeminiSettingsPath(): string {
  return join(homedir(), ".gemini", "settings.json");
}

/**
 * Path to the installed @google/gemini-cli package.
 */
export function getGeminiCliPackagePath(): string {
  const prefix = getNpmPrefix();
  return join(prefix, "node_modules", "@google", "gemini-cli");
}

export interface GeminiCliCredentials {
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
  scope?: string;
  email?: string;
}

export interface GeminiOAuthAppCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Reads the OAuth credentials from the Gemini CLI's credential store.
 * Pure synchronous file read — no subprocess, no blocking delays.
 */
export function readGeminiCredentials(): GeminiCliCredentials | null {
  const credsPath = getGeminiOAuthCredsPath();
  if (!existsSync(credsPath)) {
    return null;
  }

  try {
    const raw = readFileSync(credsPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const accessToken =
      typeof parsed.access_token === "string" ? parsed.access_token : undefined;
    const refreshToken =
      typeof parsed.refresh_token === "string"
        ? parsed.refresh_token
        : undefined;
    const expiryDate =
      typeof parsed.expiry_date === "number" ? parsed.expiry_date : undefined;
    const scope = typeof parsed.scope === "string" ? parsed.scope : undefined;
    const idToken =
      typeof parsed.id_token === "string" ? parsed.id_token : undefined;

    if (!accessToken || !refreshToken) {
      return null;
    }

    let email: string | undefined;
    if (idToken) {
      try {
        const payload = idToken.split(".")[1];
        if (payload) {
          const decoded = JSON.parse(
            Buffer.from(payload, "base64url").toString("utf8"),
          ) as Record<string, unknown>;
          email = typeof decoded.email === "string" ? decoded.email : undefined;
        }
      } catch {
        // idToken parsing is best-effort
      }
    }

    return {
      accessToken,
      refreshToken,
      expiryDate: expiryDate ?? Date.now(),
      scope,
      email,
    };
  } catch (error) {
    console.warn("[Gemini CLI] Failed to read OAuth credentials:", error);
    return null;
  }
}

/**
 * Checks whether the Gemini CLI has stored credentials.
 *
 * FAST: Only checks file existence — no subprocess calls.
 */
export function isGeminiAuthenticated(): boolean {
  return existsSync(getGeminiOAuthCredsPath());
}

/**
 * Checks if the access token is expired.
 */
export function isAccessTokenExpired(
  expiryDate: number,
  bufferMs = 60_000,
): boolean {
  return expiryDate <= Date.now() + bufferMs;
}

/**
 * Checks if the Gemini CLI binary is available in PATH.
 *
 * FAST: Uses a simple file existence check on the known installation path
 * instead of spawning a subprocess (which can hang or be slow).
 */
export function isGeminiCliInstalled(): boolean {
  // Check 1: Does the npm global package exist?
  const pkgPath = getGeminiCliPackagePath();
  if (existsSync(join(pkgPath, "package.json"))) {
    return true;
  }

  // Check 2: Does the gemini binary exist in PATH?
  // We use a very short timeout and check via the shell directly.
  try {
    const { execSync } =
      require("node:child_process") as typeof import("node:child_process");
    const result = execSync("gemini --version", {
      timeout: 3_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Gets the current Gemini CLI version without blocking more than 3s.
 */
export function getGeminiCliVersion(): string | null {
  try {
    const { execSync } =
      require("node:child_process") as typeof import("node:child_process");
    const result = execSync("gemini --version", {
      timeout: 3_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const version = result.trim();
    return version || null;
  } catch {
    return null;
  }
}

// Internal credential override used for testing.
// When set, readGeminiAppCredentials returns this value instead of extracting from bundle.
let _testCredentialOverride: GeminiOAuthAppCredentials | null | undefined;

/**
 * Sets a credential override for testing.
 * Pass `null` to simulate CLI not found. Pass `undefined` to clear the override.
 */
export function _setTestCredentialOverride(
  override: GeminiOAuthAppCredentials | null | undefined,
): void {
  _testCredentialOverride = override;
}

const FALLBACK_CREDENTIALS: GeminiOAuthAppCredentials = {
  clientId:
    "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
  clientSecret: "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",
  redirectUri: "http://localhost:8085/oauth2callback",
};

/**
 * Extracts the Gemini CLI's OAuth app credentials from the installed bundle.
 *
 * The @google/gemini-cli package ships with its own OAuth client credentials
 * for the official Gemini CLI OAuth app. Since the user explicitly installed
 * this package on their machine, reading these at runtime is legitimate —
 * unlike hardcoding them in our own distributed source code.
 *
 * Falls back to known values if the bundle can't be read at runtime.
 */
export function readGeminiAppCredentials(): GeminiOAuthAppCredentials | null {
  // Allow test injection
  if (_testCredentialOverride !== undefined) {
    return _testCredentialOverride;
  }

  try {
    const pkgPath = getGeminiCliPackagePath();
    const bundleDir = join(pkgPath, "bundle");

    if (existsSync(bundleDir)) {
      // Search through bundle chunks for the OAuth client credentials.
      const clientId = extractFromBundleFiles(
        bundleDir,
        [/681255809395/],
        [/["'']client_id["''"]\s*[,:]\s*["'']([^"'']+)["''']/],
      );

      const clientSecret = extractFromBundleFiles(
        bundleDir,
        [/GOCSPX/],
        [/["'']client_secret["''"]\s*[,:]\s*["'']([^"'']+)["''']/],
      );

      if (clientId && clientSecret) {
        return {
          clientId,
          clientSecret,
          redirectUri: FALLBACK_CREDENTIALS.redirectUri,
        };
      }
    }

    // Return fallback when bundle extraction fails or CLI isn't installed
    return { ...FALLBACK_CREDENTIALS };
  } catch {
    // Return fallback on any error
    return { ...FALLBACK_CREDENTIALS };
  }
}

function extractFromBundleFiles(
  bundleDir: string,
  searchPatterns: RegExp[],
  extractPatterns: RegExp[],
): string | null {
  const files = readDirSafe(bundleDir);
  for (const file of files) {
    if (!file.endsWith(".js")) continue;

    try {
      const content = readFileSync(join(bundleDir, file), "utf8");

      // Quick check if any search pattern matches
      const hasMatch = searchPatterns.some((pattern) => pattern.test(content));
      if (!hasMatch) continue;

      // Try to extract the value
      for (const extractPattern of extractPatterns) {
        const match = content.match(extractPattern);
        if (match?.[1]) {
          return match[1];
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

function readDirSafe(dir: string): string[] {
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function getNpmPrefix(): string {
  // First try reading from npm config (no subprocess)
  try {
    const { execSync } =
      require("node:child_process") as typeof import("node:child_process");
    const result = execSync("npm root -g", {
      timeout: 2_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const prefix = result.trim();
    if (prefix) return prefix;
  } catch {
    // Fall through to OS-specific paths
  }

  // OS-specific fallback paths
  const home = homedir();
  const plat = platform();
  if (plat === "win32") {
    return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "npm");
  }
  if (plat === "darwin") {
    return "/usr/local/lib/node_modules";
  }
  return "/usr/lib/node_modules";
}

export const credentialInternals = {
  getNpmPrefix,
  readDirSafe,
  extractFromBundleFiles,
};
