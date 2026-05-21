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
 *
 * Uses well-known OS paths for npm's global node_modules directory.
 * No subprocess calls — 100% fast and reliable.
 */
export function getGeminiCliPackagePath(): string {
  const globalNodeModules = getGlobalNodeModulesPath();
  return join(globalNodeModules, "@google", "gemini-cli");
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
 * Checks if the Gemini CLI is installed by looking for the npm package on disk.
 *
 * 100% synchronous file check — no subprocess, no execSync, no blocking.
 */
export function isGeminiCliInstalled(): boolean {
  const pkgPath = getGeminiCliPackagePath();
  return existsSync(join(pkgPath, "package.json"));
}

/**
 * Gets the current Gemini CLI version by reading the package.json.
 * No subprocess — pure synchronous JSON parse.
 */
export function getGeminiCliVersion(): string | null {
  const pkgPath = getGeminiCliPackagePath();
  const pkgJsonPath = join(pkgPath, "package.json");
  if (!existsSync(pkgJsonPath)) {
    return null;
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      version?: string;
    };
    return pkg.version?.trim() || null;
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

let _cachedAppCredentials: GeminiOAuthAppCredentials | null | undefined;

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

  // Return cached value if previously extracted
  if (_cachedAppCredentials !== undefined) {
    return _cachedAppCredentials;
  }

  try {
    const pkgPath = getGeminiCliPackagePath();
    const bundleDir = join(pkgPath, "bundle");

    if (existsSync(bundleDir)) {
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
        const creds: GeminiOAuthAppCredentials = {
          clientId,
          clientSecret,
          redirectUri: "http://localhost:8085/oauth2callback",
        };
        _cachedAppCredentials = creds;
        return creds;
      }
    }

    // No credentials found in bundle — CLI may not be installed
    _cachedAppCredentials = null;
    return null;
  } catch {
    _cachedAppCredentials = null;
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

/**
 * Returns the global node_modules path based on the current OS.
 * No subprocess calls — uses well-known OS conventions.
 */
function getGlobalNodeModulesPath(): string {
  const plat = platform();
  const home = homedir();

  if (plat === "win32") {
    // Windows: %APPDATA%\npm\node_modules
    return join(
      process.env.APPDATA ?? join(home, "AppData", "Roaming"),
      "npm",
      "node_modules",
    );
  }

  if (plat === "darwin") {
    // macOS: /usr/local/lib/node_modules (homebrew) or ~/.npm-global/lib/node_modules
    const homeNodeModules = join(home, ".npm-global", "lib", "node_modules");
    if (existsSync(homeNodeModules)) {
      return homeNodeModules;
    }
    return "/usr/local/lib/node_modules";
  }

  // Linux: check common paths
  const homeNodeModules = join(home, ".npm-global", "lib", "node_modules");
  if (existsSync(homeNodeModules)) {
    return homeNodeModules;
  }
  return "/usr/lib/node_modules";
}

export const credentialInternals = {
  getGlobalNodeModulesPath,
  readDirSafe,
  extractFromBundleFiles,
};
