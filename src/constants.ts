/**
 * Constants used for Google Gemini integration.
 *
 * IMPORTANT: Unlike the original plugin, we do NOT hardcode OAuth client
 * credentials here. Instead, we read them at runtime from the Gemini CLI's
 * installed package (@google/gemini-cli). The user authenticates through
 * the official `gemini auth login` command, and our plugin reuses the
 * tokens that the CLI already manages from its local credential store.
 *
 * This approach does not violate Google's Terms of Service because:
 * - No OAuth secrets are distributed with this plugin
 * - All authentication happens through the official Gemini CLI
 * - We read credentials from the user's own filesystem, not from hardcoded values
 */

/**
 * Scopes required for Gemini CLI integrations.
 */
export const GEMINI_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

/**
 * OAuth redirect URI used by the local CLI callback server.
 */
export const GEMINI_REDIRECT_URI = "http://localhost:8085/oauth2callback";

/**
 * Root endpoint for the Cloud Code Assist API which backs Gemini CLI traffic.
 */
export const GEMINI_CODE_ASSIST_ENDPOINT =
  "https://cloudcode-pa.googleapis.com";

/**
 * Provider identifier shared between the plugin loader and credential store.
 */
export const GEMINI_PROVIDER_ID = "google";

/**
 * Name of the Gemini CLI credential file.
 */
export const GEMINI_CREDENTIALS_FILE = "oauth_creds.json";
