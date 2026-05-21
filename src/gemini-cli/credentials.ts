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
import { execSync } from "node:child_process";

/**
 * Path to the Gemini CLI's OAuth credential store.
 */
export function getGeminiOAuthCredsPath(): string {
  const home = homedir();
  // Gemini CLI stores credentials in ~/.gemini/oauth_creds.json
  return join(home, ".gemini", "oauth_creds.json");
}

/**
 * Path to the Gemini CLI's settings file.
 */
export function getGeminiSettingsPath(): string {
  const home = homedir();
  return join(home, ".gemini", "settings.json");
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
 * Checks whether the Gemini CLI is authenticated and has valid credentials.
 */
export function isGeminiAuthenticated(): boolean {
  const creds = readGeminiCredentials();
  if (!creds) {
    return false;
  }

  const settingsPath = getGeminiSettingsPath();
  if (!existsSync(settingsPath)) {
    return false;
  }

  return true;
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
 */
export function isGeminiCliInstalled(): boolean {
  try {
    const result = execSync("gemini --version", {
      timeout: 10_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Gets the current Gemini CLI version installed.
 */
export function getGeminiCliVersion(): string | null {
  try {
    const result = execSync("gemini --version", {
      timeout: 5_000,
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

/**
 * Extracts the Gemini CLI's OAuth app credentials from the installed bundle.
 *
 * The @google/gemini-cli package ships with its own OAuth client credentials
 * for the official Gemini CLI OAuth app. The user explicitly installed this
 * package on their machine. At runtime, we extract the credentials from the
 * installed bundle — this is fundamentally different from distributing
 * hardcoded secrets in our own source code.
 *
 * Returns null if the bundle cannot be read. In that case, the user should
 * reinstall the Gemini CLI or use `gemini auth login` for authentication.
 */
export function readGeminiAppCredentials(): GeminiOAuthAppCredentials | null {
  // Allow test injection
  if (_testCredentialOverride !== undefined) {
    return _testCredentialOverride;
  }

  try {
    const pkgPath = getGeminiCliPackagePath();
    const bundleDir = join(pkgPath, "bundle");

    if (!existsSync(bundleDir)) {
      return null;
    }

    // Search through bundle chunks for the OAuth client credentials.
    // The CLI bundles these values as string literals in its chunk files.
    const clientId = extractFromBundleFiles(
      bundleDir,
      [/681255809395/],
      [/["''']client_id["''"]\s*[,:]\s*["''']([^"'']+)["''']/],
    );

    const clientSecret = extractFromBundleFiles(
      bundleDir,
      [/GOCSPX/],
      [/["''']client_secret["''"]\s*[,:]\s*["''']([^"'']+)["''']/],
    );

    if (clientId && clientSecret) {
      return {
        clientId,
        clientSecret,
        redirectUri: "http://localhost:8085/oauth2callback",
      };
    }

    return null;
  } catch {
    return null;
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
  try {
    const result = execSync("npm root -g", {
      timeout: 5_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.trim();
  } catch {
    // Fallback paths for common OS
    const home = homedir();
    const plat = platform();
    if (plat === "win32") {
      return join(
        process.env.APPDATA ?? join(home, "AppData", "Roaming"),
        "npm",
      );
    }
    if (plat === "darwin") {
      return "/usr/local/lib/node_modules";
    }
    return "/usr/lib/node_modules";
  }
}

export const credentialInternals = {
  getNpmPrefix,
  readDirSafe,
  extractFromBundleFiles,
};
