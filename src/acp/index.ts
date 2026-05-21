/**
 * ACP (Agent Communication Protocol) client for Gemini CLI.
 *
 * This module establishes a persistent JSON-RPC 2.0 connection to the
 * Gemini CLI running in --acp mode, allowing the plugin to delegate
 * all authentication and API calls to the official CLI.
 *
 * Usage:
 *   import { AcpClient } from "./acp";
 *
 *   const client = await AcpClient.create();
 *   await client.initialize();
 *   await client.authenticate();
 *   const sessionId = await client.createSession();
 *   client.onStream((chunk) => process.stdout.write(chunk));
 *   const result = await client.sendPrompt(sessionId, "Hello!");
 *   console.log(result.usage);
 *   await client.destroy();
 */

export { AcpClient } from "./client";
export type { AcpClientConfig, PromptResponse } from "./client";
export { connectAcp } from "./connection";
export type { AcpConnection } from "./connection";
export {
  AGENT_METHODS,
  CLIENT_METHODS,
  type InitializeResult,
  type PromptParams,
  type PromptResult,
  type PromptMessage,
  type PromptContent,
  type TextContent,
  type SessionUpdateParams,
  textBlock,
} from "./protocol";
