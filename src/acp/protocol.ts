/**
 * ACP (Agent Communication Protocol) types for the Gemini CLI.
 *
 * The Gemini CLI's --acp mode implements version 1 of the ACP protocol,
 * a JSON-RPC 2.0 based protocol for agent-to-agent communication.
 *
 * Reference: built-in ACP implementation in @google/gemini-cli bundle.
 */

// ─── JSON-RPC 2.0 Base ───────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ─── ACP Agent Methods (Gemini CLI implements these) ─────────────

export const AGENT_METHODS = {
  initialize: "initialize",
  authenticate: "authenticate",
  sessionNew: "session/new",
  sessionClose: "session/close",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionSetModel: "session/set_model",
  sessionSetConfigOption: "session/set_config_option",
} as const;

// ─── ACP Client Methods (Plugin must handle these) ───────────────

export const CLIENT_METHODS = {
  fsReadTextFile: "fs/read_text_file",
  sessionUpdate: "session/update",
  sessionRequestPermission: "session/request_permission",
} as const;

// ─── Initialize ──────────────────────────────────────────────────

export interface InitializeParams {
  protocolVersion: number;
  clientInfo: {
    name: string;
    version: string;
  };
  capabilities?: Record<string, unknown>;
}

export interface InitializeResult {
  protocolVersion: number;
  authMethods?: AuthMethod[];
  agentInfo: {
    name: string;
    title: string;
    version: string;
  };
  agentCapabilities: {
    loadSession?: boolean;
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
    mcpCapabilities?: {
      http?: boolean;
      sse?: boolean;
    };
  };
}

export interface AuthMethod {
  id: string;
  label: string;
  type: "oauth" | "api" | "env_var";
}

// ─── Authenticate ────────────────────────────────────────────────

export interface AuthenticateParams {
  methodId: string;
}

// ─── Session ─────────────────────────────────────────────────────

export interface NewSessionParams {
  scopes?: string[];
}

export interface NewSessionResult {
  sessionId: string;
}

export interface CloseSessionParams {
  sessionId: string;
}

// ─── Prompt ──────────────────────────────────────────────────────

export interface PromptMessage {
  role: "user" | "model" | "system";
  content: PromptContent[];
}

export type PromptContent =
  | TextContent
  | ImageContent
  | AudioContent;

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

export interface AudioContent {
  type: "audio";
  data: string; // base64
  mimeType: string;
}

export interface PromptParams {
  sessionId: string;
  prompt: PromptMessage[];
  messageId?: string;
}

export interface PromptResult {
  stopReason?: string;
  usage?: {
    totalTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
  };
  userMessageId?: string;
}

// ─── Session Update (streaming notification) ─────────────────────

export interface SessionUpdateParams {
  type: "content_chunk" | "status" | "error";
  messageId?: string;
  content?: PromptContent;
  status?: string;
  error?: string;
}

// ─── Client Method Stubs ─────────────────────────────────────────

export interface FsReadTextFileParams {
  path: string;
}

export interface RequestPermissionParams {
  permission: string;
  description?: string;
}

/**
 * Convenience: build a valid ACP text content block.
 */
export function textBlock(text: string): TextContent {
  return { type: "text", text };
}
