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
  return join(homedir(), ".gemini", "oauth_creds.json");
}

/**
 * Path to the installed @google/gemini-cli package.
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
  if (!existsSync(credsPath)) return null;

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
    const idToken =
      typeof parsed.id_token === "string" ? parsed.id_token : undefined;

    if (!accessToken || !refreshToken) return null;

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
        /* best-effort */
      }
    }

    return {
      accessToken,
      refreshToken,
      expiryDate: expiryDate ?? Date.now(),
      scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
      email,
    };
  } catch {
    return null;
  }
}

/**
 * Checks if the access token is expired (with buffer for clock skew).
 */
export function isAccessTokenExpired(
  expiryDate: number,
  bufferMs = 60_000,
): boolean {
  return expiryDate <= Date.now() + bufferMs;
}

/**
 * Checks whether the Gemini CLI has stored credentials.
 */
export function isGeminiAuthenticated(): boolean {
  return existsSync(getGeminiOAuthCredsPath());
}

/**
 * Path to the Gemini CLI's settings file.
 */
export function getGeminiSettingsPath(): string {
  return join(homedir(), ".gemini", "settings.json");
}

/**
 * Checks if the Gemini CLI is installed by looking for the npm package on disk.
 */
export function isGeminiCliInstalled(): boolean {
  return existsSync(join(getGeminiCliPackagePath(), "package.json"));
}

/**
 * Gets the current Gemini CLI version by reading the package.json.
 */
export function getGeminiCliVersion(): string | null {
  const pkgJsonPath = join(getGeminiCliPackagePath(), "package.json");
  if (!existsSync(pkgJsonPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      version?: string;
    };
    return pkg.version?.trim() || null;
  } catch {
    return null;
  }
}

// Internal override for testing
let _testCredentialOverride: GeminiOAuthAppCredentials | null | undefined;

export function _setTestCredentialOverride(
  override: GeminiOAuthAppCredentials | null | undefined,
): void {
  _testCredentialOverride = override;
}

// Cache for extracted credentials
let _cachedAppCredentials: GeminiOAuthAppCredentials | null | undefined;

/**
 * Extracts the Gemini CLI's OAuth app credentials from the installed bundle.
 *
 * The @google/gemini-cli package bundles OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET
 * as string literals. We read these at runtime from the locally installed CLI.
 * Returns null if the CLI isn't installed or the bundle can't be read.
 */
export function readGeminiAppCredentials(): GeminiOAuthAppCredentials | null {
  if (_testCredentialOverride !== undefined) return _testCredentialOverride;
  if (_cachedAppCredentials !== undefined) return _cachedAppCredentials;

  try {
    const pkgPath = getGeminiCliPackagePath();
    const bundleDir = join(pkgPath, "bundle");
    if (!existsSync(bundleDir)) {
      _cachedAppCredentials = null;
      return null;
    }

    const files = readDirSafe(bundleDir);
    let clientId: string | null = null;
    let clientSecret: string | null = null;

    for (const file of files) {
      if (!file.endsWith(".js")) continue;
      try {
        const content = readFileSync(join(bundleDir, file), "utf8");

        if (!clientId) {
          const idMatch = content.match(/OAUTH_CLIENT_ID\s*=\s*"([^"]+)"/);
          if (idMatch?.[1]) clientId = idMatch[1];
        }

        if (!clientSecret) {
          const secretMatch = content.match(
            /OAUTH_CLIENT_SECRET\s*=\s*"([^"]+)"/,
          );
          if (secretMatch?.[1]) clientSecret = secretMatch[1];
        }

        if (clientId && clientSecret) break;
      } catch {
        /* skip unreadable files */
      }
    }

    if (clientId && clientSecret) {
      const creds: GeminiOAuthAppCredentials = {
        clientId,
        clientSecret,
        redirectUri: "http://localhost:8085/oauth2callback",
      };
      _cachedAppCredentials = creds;
      return creds;
    }

    _cachedAppCredentials = null;
    return null;
  } catch {
    _cachedAppCredentials = null;
    return null;
  }
}

/**
 * Returns the global node_modules path based on the current OS.
 */
function getGlobalNodeModulesPath(): string {
  const plat = platform();
  const home = homedir();

  // Try `npm root -g` first (fast subprocess)
  try {
    const result = execSync("npm root -g", {
      timeout: 3000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const prefix = result.trim();
    if (
      prefix &&
      existsSync(join(prefix, "@google", "gemini-cli", "package.json"))
    ) {
      return prefix;
    }
  } catch {
    /* fall through */
  }

  // OS-specific fallbacks
  if (plat === "win32") {
    return join(
      process.env.APPDATA ?? join(home, "AppData", "Roaming"),
      "npm",
      "node_modules",
    );
  }
  if (plat === "darwin") {
    const homeNm = join(home, ".npm-global", "lib", "node_modules");
    if (existsSync(homeNm)) return homeNm;
    return "/usr/local/lib/node_modules";
  }
  const homeNm = join(home, ".npm-global", "lib", "node_modules");
  if (existsSync(homeNm)) return homeNm;
  return "/usr/lib/node_modules";
}

function readDirSafe(dir: string): string[] {
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export const credentialInternals = { getGlobalNodeModulesPath, readDirSafe };
