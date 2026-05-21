export { GeminiCLIOAuthPlugin, GoogleOAuthPlugin } from "./src/plugin";

export {
  authorizeGemini,
  exchangeGeminiWithVerifier,
} from "./src/gemini/oauth";

export type {
  GeminiAuthorization,
  GeminiTokenExchangeResult,
} from "./src/gemini/oauth";

// Export Gemini CLI bridge utilities (for diagnostics / external use)
export {
  readGeminiCredentials,
  readGeminiAppCredentials,
  isGeminiAuthenticated,
  isGeminiCliInstalled,
  isAccessTokenExpired,
  getGeminiCliVersion,
} from "./src/gemini-cli";

export type {
  GeminiCliCredentials,
  GeminiOAuthAppCredentials,
} from "./src/gemini-cli";
