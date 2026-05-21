import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cachedPluginVersion: string | undefined;

/**
 * Resolves the plugin's own version for User-Agent.
 * Uses the package.json version at runtime.
 */
export function getPluginVersion(): string {
  if (cachedPluginVersion) {
    return cachedPluginVersion;
  }

  const envVersion = process.env.npm_package_version?.trim();
  if (envVersion) {
    cachedPluginVersion = envVersion;
    return cachedPluginVersion;
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    join(moduleDir, "../../package.json"),
    join(moduleDir, "../package.json"),
    join(process.cwd(), "package.json"),
  ];

  for (const packagePath of candidatePaths) {
    try {
      const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as {
        version?: unknown;
      };
      if (typeof parsed.version === "string" && parsed.version.trim()) {
        cachedPluginVersion = parsed.version.trim();
        return cachedPluginVersion;
      }
    } catch {
      continue;
    }
  }

  cachedPluginVersion = "0.0.0";
  return cachedPluginVersion;
}

/**
 * Builds a transparent User-Agent string that identifies this plugin
 * without impersonating the Gemini CLI.
 *
 * Unlike the original plugin, we do NOT masquerade as `GeminiCLI/X.Y.Z`.
 * Instead, we use our own identity: `OpencodeGeminiAuth/X.Y.Z`.
 */
export function buildGeminiCliUserAgent(model?: string): string {
  const modelSegment = model?.trim() || "gemini-code-assist";
  const platformSegment = `${process.platform}; ${process.arch}`;
  return `OpencodeGeminiAuth/${getPluginVersion()} (${platformSegment})`;
}

/**
 * Resets cached version. Used for testing only.
 */
export function _resetVersionCache(): void {
  cachedPluginVersion = undefined;
}
