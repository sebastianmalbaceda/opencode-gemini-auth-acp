/**
 * Simple Gemini CLI subprocess runner.
 *
 * Uses `gemini -p` (non-interactive prompt mode) instead of the complex ACP protocol.
 * The CLI's `-p` mode works reliably and returns JSON with the response text.
 */

import { spawn } from "node:child_process";

const CLI_TIMEOUT_MS = 60_000;

export interface GeminiRunResult {
  text: string;
  model?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

/**
 * Runs `gemini -p` with the given message and model.
 * Returns the response text from the CLI.
 */
export async function runGeminiPrompt(
  message: string,
  options?: {
    model?: string;
    systemPrompt?: string;
    onChunk?: (text: string) => void;
  },
): Promise<GeminiRunResult> {
  // Build the prompt: system + user message
  let fullPrompt = message;
  if (options?.systemPrompt) {
    fullPrompt = `${options.systemPrompt}\n\n${message}`;
  }

  const model = options?.model || "gemini-2.5-flash";

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const stderrChunks: string[] = [];

    const proc = spawn("gemini", [
      "--model", model,
      "-p", fullPrompt,
      "--output-format", "json",
      "--skip-trust",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let timeout: ReturnType<typeof setTimeout> | null = null;

    if (proc.stdout) {
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
    }

    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString());
      });
    }

    proc.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      reject(new Error(`Gemini CLI error: ${err.message}`));
    });

    proc.on("exit", (code) => {
      if (timeout) clearTimeout(timeout);

      if (code !== 0 && code !== null) {
        const stderr = stderrChunks.join("").trim().slice(0, 300);
        reject(
          new Error(
            `Gemini CLI exited (code ${code})${stderr ? `: ${stderr}` : ""}`,
          ),
        );
        return;
      }

      try {
        // Parse the JSON output
        // The output is a JSON object with "response", "session_id", "stats" fields
        const lines = stdout.trim().split("\n");
        let jsonStr = "";

        // Find the JSON object (skip any non-JSON lines like warnings)
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("{")) {
            jsonStr = trimmed;
            break;
          }
        }

        if (!jsonStr) {
          reject(new Error("No JSON response from Gemini CLI"));
          return;
        }

        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        const responseText = typeof parsed.response === "string" ? parsed.response : "";

        // Extract usage if available
        let inputTokens: number | undefined;
        let outputTokens: number | undefined;
        const stats = parsed.stats as Record<string, unknown> | undefined;
        if (stats) {
          const models = stats.models as Record<string, unknown> | undefined;
          if (models) {
            // Take the first model's token info
            const firstModel = Object.values(models)[0] as Record<string, unknown> | undefined;
            const tokens = firstModel?.tokens as Record<string, unknown> | undefined;
            if (tokens) {
              inputTokens = tokens.prompt as number | undefined;
              outputTokens = tokens.candidates as number | undefined;
            }
          }
        }

        resolve({
          text: responseText,
          model,
          usage: inputTokens !== undefined ? { inputTokens, outputTokens } : undefined,
        });
      } catch (err) {
        reject(
          new Error(
            `Failed to parse Gemini CLI output: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });

    // Timeout
    timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Gemini CLI timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);
  });
}
