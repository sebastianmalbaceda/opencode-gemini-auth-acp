/**
 * High-level ACP client that wraps the JSON-RPC connection to the Gemini CLI.
 * Handles: initialize, authenticate, session management, and prompting.
 */

import type { AcpConnection } from "./connection";
import { connectAcp } from "./connection";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  type InitializeResult,
  type NewSessionResult,
  type PromptResult,
  type SessionUpdateParams,
  type TextContent,
  textBlock,
} from "./protocol";

export interface AcpClientConfig {
  promptTimeoutMs?: number;
}

export interface PromptResponse {
  text: string;
  usage?: {
    totalTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
  };
  stopReason?: string;
}

/**
 * ACP client that manages a persistent Gemini CLI --acp subprocess.
 */
export class AcpClient {
  private conn: AcpConnection;
  private sessionId: string | null = null;
  private collectedText = "";
  private chunkCallback: ((text: string) => void) | null = null;

  private constructor(conn: AcpConnection, _config?: AcpClientConfig) {
    this.conn = conn;

    // Handle notifications (streaming content from CLI)
    this.conn.onNotification((method: string, params: unknown) => {
      if (method === CLIENT_METHODS.sessionUpdate) {
        this.handleSessionUpdate(params as SessionUpdateParams);
      }
    });

    // Handle inbound requests from the CLI (fs, terminal, permissions)
    this.conn.onRequest((method: string, params: unknown) =>
      this.handleClientRequest(method, params),
    );
  }

  // ─── Factory ──────────────────────────────────────────────

  static async create(config?: AcpClientConfig): Promise<AcpClient> {
    const conn = await connectAcp();
    return new AcpClient(conn, config);
  }

  // ─── Initialize ───────────────────────────────────────────

  async initialize(): Promise<InitializeResult> {
    return this.conn.request<InitializeResult>(AGENT_METHODS.initialize, {
      protocolVersion: 1,
      clientInfo: {
        name: "opencode-gemini-auth",
        version: "1.4.15",
      },
      capabilities: {},
    });
  }

  // ─── Authenticate ─────────────────────────────────────────

  async authenticate(methodId = "oauth-personal"): Promise<void> {
    await this.conn.request(AGENT_METHODS.authenticate, { methodId });
  }

  // ─── Session Management ───────────────────────────────────

  async createSession(cwd?: string): Promise<string> {
    const result = await this.conn.request<NewSessionResult>(
      AGENT_METHODS.sessionNew,
      {
        cwd: cwd ?? process.cwd(),
        mcpServers: [],
      },
    );
    this.sessionId = result.sessionId;
    return result.sessionId;
  }

  async closeSession(sessionId?: string): Promise<void> {
    const id = sessionId ?? this.sessionId;
    if (!id) return;
    try {
      await this.conn.request(AGENT_METHODS.sessionClose, { sessionId: id });
    } catch {
      // Best effort
    }
    if (this.sessionId === id) {
      this.sessionId = null;
    }
  }

  // ─── Prompt (with streaming) ──────────────────────────────

  /**
   * Send a prompt and stream the response via the onChunk callback.
   *
   * ACP expects content blocks directly in the prompt array (not wrapped
   * in {role, content} objects).
   */
  async sendPrompt(
    sessionId: string,
    message: string,
    options?: {
      onChunk?: (text: string) => void;
      systemPrompt?: string;
    },
  ): Promise<PromptResponse> {
    const blocks: Array<{ type: "text"; text: string }> = [];
    if (options?.systemPrompt) {
      blocks.push({ type: "text", text: options.systemPrompt });
    }
    blocks.push({ type: "text", text: message });

    this.collectedText = "";
    this.chunkCallback = options?.onChunk ?? null;

    const result = await this.conn.request<PromptResult>(
      AGENT_METHODS.sessionPrompt,
      { sessionId, prompt: blocks },
    );

    this.chunkCallback = null;

    return {
      text: this.collectedText,
      stopReason: result.stopReason,
      usage: result.usage
        ? {
            totalTokens: result.usage.totalTokens,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
          }
        : undefined,
    };
  }

  private handleSessionUpdate(params: SessionUpdateParams): void {
    switch (params.type) {
      case "content_chunk": {
        const content = params.content;
        if (content?.type === "text") {
          const text = (content as TextContent).text;
          this.collectedText += text;
          this.chunkCallback?.(text);
        }
        break;
      }
      case "error": {
        if (params.error) {
          console.error("[ACP] Stream error:", params.error);
        }
        break;
      }
    }
  }

  private async handleClientRequest(
    method: string,
    _params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case CLIENT_METHODS.fsReadTextFile:
        return { content: null };
      case CLIENT_METHODS.sessionRequestPermission:
        return { granted: false, reason: "Denied by ACP client" };
      default:
        return {};
    }
  }

  // ─── Teardown ─────────────────────────────────────────────

  async destroy(): Promise<void> {
    if (this.sessionId) {
      await this.closeSession(this.sessionId).catch(() => {});
    }
    await this.conn.close();
  }

  get isConnected(): boolean {
    return this.conn.isConnected;
  }
}
