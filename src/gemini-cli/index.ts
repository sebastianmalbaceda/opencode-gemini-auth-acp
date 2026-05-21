/**
 * Gemini CLI integration for Opencode.
 *
 * This module bridges the official Gemini CLI (`@google/gemini-cli`) with
 * the Opencode plugin system. Instead of hardcoding OAuth credentials or
 * impersonating the CLI, we:
 *
 * 1. Read tokens from the CLI's local credential store
 * 2. Use the CLI's OAuth app credentials for token refresh (read from the
 *    locally installed bundle at runtime)
 * 3. Provide clear guidance when the CLI isn't installed or authenticated
 *
 * This approach ensures:
 * - No hardcoded secrets in our distributed code
 * - No impersonation of the Gemini CLI
 * - Users authenticate through the official `gemini auth login` command
 * - Same smooth DX as the current plugin
 */

export {
  readGeminiCredentials,
  readGeminiAppCredentials,
  isGeminiAuthenticated,
  isGeminiCliInstalled,
  isAccessTokenExpired,
  getGeminiCliVersion,
  getGeminiOAuthCredsPath,
  getGeminiSettingsPath,
  getGeminiCliPackagePath,
  _setTestCredentialOverride,
  type GeminiCliCredentials,
  type GeminiOAuthAppCredentials,
  credentialInternals,
} from "./credentials";
