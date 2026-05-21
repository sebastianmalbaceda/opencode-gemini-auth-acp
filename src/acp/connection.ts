/**
 * Manages the Gemini CLI subprocess lifecycle and JSON-RPC 2.0 communication
 * over stdin/stdout when running in --acp mode.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from "./protocol";

const ACP_REQUEST_TIMEOUT_MS = 60_000;
let nextRequestId = 1;

function debugLog(msg: string): void {
  if (process.env.OPENCODE_GEMINI_DEBUG === "1") {
    console.error(`[ACP] ${msg}`);
  }
}

export interface AcpConnection {
  request<T>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (method: string, params: unknown) => void): void;
  onRequest(
    handler: (method: string, params: unknown) => Promise<unknown>,
  ): void;
  close(): Promise<void>;
  get isConnected(): boolean;
}

/**
 * Spawns `gemini --acp` and returns a connection handle.
 */
export async function connectAcp(): Promise<AcpConnection> {
  const stderrChunks: string[] = [];

  const proc = spawn("gemini", ["--acp"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  if (!proc.stdin || !proc.stdout) {
    throw new Error("Failed to spawn gemini --acp: missing stdio pipes");
  }

  // Capture stderr for diagnostics
  if (proc.stderr) {
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });
  }

  // ─── Pending requests map ──────────────────────────────────
  const pending = new Map<
    number | string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  let notifyHandler: ((method: string, params: unknown) => void) | null = null;
  let requestHandler:
    | ((method: string, params: unknown) => Promise<unknown>)
    | null = null;

  // ─── Parse incoming JSON-RPC messages ──────────────────────
  const rl = createInterface({ input: proc.stdout });
  let closed = false;

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // silently ignore non-JSON lines (like warnings)
    }

    if (!msg || typeof msg !== "object") return;

    const hasId = "id" in (msg as Record<string, unknown>);
    const hasMethod = "method" in (msg as Record<string, unknown>);

    if (hasId && hasMethod) {
      // ── Inbound request from CLI (e.g. fs/read_text_file, session/update) ──
      const req = msg as JsonRpcRequest;
      if (requestHandler) {
        requestHandler(req.method, req.params)
          .then((result) =>
            writeJson(proc, { jsonrpc: "2.0", id: req.id, result }),
          )
          .catch((error) =>
            writeJson(proc, {
              jsonrpc: "2.0",
              id: req.id,
              error: { code: -1, message: error.message ?? "Error" },
            }),
          );
      } else {
        writeJson(proc, {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: "Method not implemented" },
        });
      }
    } else if (hasId && !hasMethod) {
      // ── Response to our request ──
      const res = msg as JsonRpcResponse;
      const pendingReq = pending.get(res.id);
      if (pendingReq) {
        clearTimeout(pendingReq.timer);
        pending.delete(res.id);
        if (res.error) {
          pendingReq.reject(
            new Error(`ACP error (${res.error.code}): ${res.error.message}`),
          );
        } else {
          pendingReq.resolve(res.result);
        }
      }
    } else if (hasMethod && !hasId) {
      // ── Notification from CLI ──
      const notif = msg as JsonRpcNotification;
      notifyHandler?.(notif.method, notif.params);
    }
  });

  // ─── Handle process exit ───────────────────────────────────
  const onExit = new Promise<void>((resolve) => {
    proc.on("exit", (code, signal) => {
      closed = true;
      const stderrLog = stderrChunks.join("").trim();
      const exitInfo = `exit code=${code} signal=${signal}`;
      const stderrInfo = stderrLog ? ` stderr: ${stderrLog.slice(0, 500)}` : "";

      for (const [, pendingReq] of pending) {
        clearTimeout(pendingReq.timer);
        pendingReq.reject(
          new Error(`ACP connection closed (${exitInfo}${stderrInfo})`),
        );
      }
      pending.clear();
      resolve();
    });
  });

  function writeJson(
    p: ChildProcess,
    msg: JsonRpcRequest | JsonRpcResponse,
  ): void {
    if (p.stdin?.writable) {
      p.stdin.write(`${JSON.stringify(msg)}\n`);
    }
  }

  // ─── Connection handle ─────────────────────────────────────
  const connection: AcpConnection = {
    request<T>(method: string, params?: unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (closed) {
          reject(new Error("ACP connection is closed"));
          return;
        }

        const id = nextRequestId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              `ACP request timeout: ${method} (${ACP_REQUEST_TIMEOUT_MS}ms)`,
            ),
          );
        }, ACP_REQUEST_TIMEOUT_MS);

        pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
          timer,
        });

        writeJson(proc, {
          jsonrpc: "2.0",
          id,
          method,
          params,
        } satisfies JsonRpcRequest);
      });
    },

    notify(method: string, params?: unknown): void {
      if (closed) return;
      writeJson(proc, {
        jsonrpc: "2.0",
        method,
        params,
      } as unknown as JsonRpcRequest);
    },

    onNotification(handler: (method: string, params: unknown) => void): void {
      notifyHandler = handler;
    },

    onRequest(
      handler: (method: string, params: unknown) => Promise<unknown>,
    ): void {
      requestHandler = handler;
    },

    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      try {
        proc.stdin?.end();
      } catch {}
      try {
        proc.kill();
      } catch {}
      return onExit;
    },

    get isConnected(): boolean {
      return !closed && proc.exitCode === null;
    },
  };

  // Small delay to ensure the process is alive before first message
  await new Promise((r) => setTimeout(r, 500));

  if (proc.exitCode !== null) {
    const stderrLog = stderrChunks.join("").trim();
    const detail = stderrLog ? ` (stderr: ${stderrLog.slice(0, 300)})` : "";
    throw new Error(
      `Gemini CLI exited immediately (code: ${proc.exitCode}${detail})`,
    );
  }

  return connection;
}

export const connectionInternals = {};
