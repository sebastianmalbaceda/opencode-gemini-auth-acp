/**
 * Manages the Gemini CLI subprocess lifecycle and JSON-RPC 2.0 communication
 * over stdin/stdout when running in --acp mode.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from "./protocol";

const ACP_CONNECT_TIMEOUT_MS = 15_000;
const ACP_REQUEST_TIMEOUT_MS = 30_000;
let nextRequestId = 1;

export interface AcpConnection {
  /** Send a JSON-RPC request and wait for the matching response. */
  request<T>(method: string, params?: unknown): Promise<T>;
  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: unknown): void;
  /** Register a handler for notifications from the CLI. */
  onNotification(handler: (method: string, params: unknown) => void): void;
  /** Register a handler for inbound requests from the CLI (client methods). */
  onRequest(
    handler: (method: string, params: unknown) => Promise<unknown>,
  ): void;
  /** Cleanly shut down the subprocess. */
  close(): Promise<void>;
  /** Check if connection is active. */
  get isConnected(): boolean;
}

/**
 * Spawns `gemini --acp` and returns a connection handle.
 */
export async function connectAcp(): Promise<AcpConnection> {
  const proc = spawn("gemini", ["--acp"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // Don't let the CLI try to read workspace context
      GEMINI_DISABLE_WORKSPACE: "1",
    },
  });

  if (!proc.stdin || !proc.stdout) {
    throw new Error("Failed to spawn gemini --acp: missing stdio pipes");
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

  // ─── Notification & inbound request handlers ───────────────
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

    try {
      const msg = JSON.parse(trimmed);

      if (isResponse(msg)) {
        // Match a pending request
        const pendingReq = pending.get(msg.id);
        if (pendingReq) {
          clearTimeout(pendingReq.timer);
          pending.delete(msg.id);
          if (msg.error) {
            pendingReq.reject(
              new Error(`ACP error (${msg.error.code}): ${msg.error.message}`),
            );
          } else {
            pendingReq.resolve(msg.result);
          }
        }
      } else if (isNotification(msg)) {
        // Forward notification to handler
        notifyHandler?.(msg.method, msg.params);
      } else if (isRequest(msg)) {
        // Handle inbound request (client method call from CLI)
        if (requestHandler) {
          requestHandler(msg.method, msg.params)
            .then((result) => {
              writeMessage(proc, {
                jsonrpc: "2.0",
                id: msg.id,
                result,
              });
            })
            .catch((error) => {
              writeMessage(proc, {
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: -1,
                  message: error.message ?? "Internal error",
                },
              });
            });
        } else {
          writeMessage(proc, {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "Method not implemented" },
          });
        }
      }
    } catch {
      // Silently ignore malformed JSON lines
    }
  });

  // ─── Handle process exit ───────────────────────────────────
  const onExit = new Promise<void>((resolve) => {
    proc.on("exit", () => {
      closed = true;
      // Reject all pending requests
      for (const [, pendingReq] of pending) {
        clearTimeout(pendingReq.timer);
        pendingReq.reject(new Error("ACP connection closed"));
      }
      pending.clear();
      resolve();
    });
  });

  // ─── Helper: write JSON-RPC message to stdin ───────────────
  function writeMessage(
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

        writeMessage(proc, {
          jsonrpc: "2.0",
          id,
          method,
          params,
        } satisfies JsonRpcRequest);
      });
    },

    notify(method: string, params?: unknown): void {
      if (closed) return;
      writeMessage(proc, {
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
      proc.stdin?.end();
      proc.kill();
      return onExit;
    },

    get isConnected(): boolean {
      // proc.exitCode is null when the process is running
      return !closed && proc.exitCode === null;
    },
  };

  // Wait for the process to be ready
  await waitForProcessReady(proc);

  return connection;
}

async function waitForProcessReady(proc: ChildProcess): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ACP_CONNECT_TIMEOUT_MS) {
    if (proc.exitCode !== null) {
      throw new Error(`Gemini CLI exited prematurely (code: ${proc.exitCode})`);
    }
    if (proc.stdout?.readable) {
      return;
    }
    await sleep(100);
  }
  throw new Error(
    `Gemini CLI did not become ready within ${ACP_CONNECT_TIMEOUT_MS}ms`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── JSON-RPC type guards ────────────────────────────────────────

function isResponse(msg: unknown): msg is JsonRpcResponse {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "jsonrpc" in msg &&
    (msg as Record<string, unknown>).jsonrpc === "2.0" &&
    "id" in msg
  );
}

function isNotification(msg: unknown): msg is JsonRpcNotification {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "jsonrpc" in msg &&
    (msg as Record<string, unknown>).jsonrpc === "2.0" &&
    "method" in msg &&
    !("id" in msg)
  );
}

function isRequest(msg: unknown): msg is JsonRpcRequest {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "jsonrpc" in msg &&
    (msg as Record<string, unknown>).jsonrpc === "2.0" &&
    "method" in msg &&
    "id" in msg
  );
}

export const connectionInternals = {
  isResponse,
  isNotification,
  isRequest,
};
