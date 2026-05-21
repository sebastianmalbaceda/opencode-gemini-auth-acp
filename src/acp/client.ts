/**
 * High-level ACP client that wraps the JSON-RPC connection to the Gemini CLI.
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
} from "./protocol";

export interface AcpClientConfig {
  promptTimeoutMs?: number;
}

export interface PromptResponse {
  text: string;
  stopReason?: string;
}

export class AcpClient {
  private conn: AcpConnection;
  private _sessionId: string | null = null;
  private collectedText = "";
  private chunkCallback: ((text: string) => void) | null = null;

  private constructor(conn: AcpConnection) {
    this.conn = conn;
    this.conn.onNotification((method: string, params: unknown) => {
      if (method === CLIENT_METHODS.sessionUpdate) {
        this.handleSessionUpdate(params as SessionUpdateParams);
      }
    });
    this.conn.onRequest((method: string, params: unknown) =>
      this.handleClientRequest(method, params),
    );
  }

  /** Expose the current session ID */
  get sessionId(): string | null {
    return this._sessionId;
  }

  static async create(config?: AcpClientConfig): Promise<AcpClient> {
    const conn = await connectAcp();
    return new AcpClient(conn);
  }

  async initialize(): Promise<InitializeResult> {
    return this.conn.request<InitializeResult>(AGENT_METHODS.initialize, {
      protocolVersion: 1,
      clientInfo: { name: "opencode-gemini-auth", version: "1.4.15" },
      capabilities: {},
    });
  }

  async authenticate(methodId = "oauth-personal"): Promise<void> {
    await this.conn.request(AGENT_METHODS.authenticate, { methodId });
  }

  async createSession(cwd?: string): Promise<string> {
    const result = await this.conn.request<NewSessionResult>(
      AGENT_METHODS.sessionNew,
      { cwd: cwd ?? process.cwd(), mcpServers: [] },
    );
    this._sessionId = result.sessionId;
    return result.sessionId;
  }

  async closeSession(sessionId?: string): Promise<void> {
    const id = sessionId ?? this._sessionId;
    if (!id) return;
    try {
      await this.conn.request(AGENT_METHODS.sessionClose, { sessionId: id });
    } catch {
      /* best effort */
    }
    if (this._sessionId === id) this._sessionId = null;
  }

  async sendPrompt(
    sessionId: string,
    message: string,
    options?: {
      onChunk?: (text: string) => void;
      systemPrompt?: string;
    },
  ): Promise<PromptResponse> {
    const blocks: Array<{ type: "text"; text: string }> = [];
    if (options?.systemPrompt)
      blocks.push({ type: "text", text: options.systemPrompt });
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
    };
  }

  private handleSessionUpdate(params: SessionUpdateParams): void {
    if (params.type === "content_chunk") {
      const c = params.content;
      if (c?.type === "text") {
        const t = (c as TextContent).text;
        this.collectedText += t;
        this.chunkCallback?.(t);
      }
    }
  }

  private async handleClientRequest(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    // session/update can arrive as EITHER a notification (no id) or a request (with id).
    // Handle it in both cases so we never miss streaming content.
    if (method === CLIENT_METHODS.sessionUpdate) {
      this.handleSessionUpdate(params as SessionUpdateParams);
      return {};
    }
    switch (method) {
      case CLIENT_METHODS.fsReadTextFile:
        return { content: null };
      case CLIENT_METHODS.sessionRequestPermission:
        return { granted: false, reason: "Denied" };
      default:
        return {};
    }
  }

  async destroy(): Promise<void> {
    if (this._sessionId)
      await this.closeSession(this._sessionId).catch(() => {});
    await this.conn.close();
  }

  get isConnected(): boolean {
    return this.conn.isConnected;
  }
}

export { connectAcp };
