/**
 * Simple Gemini CLI subprocess runner.
 *
 * Uses `gemini` in non-interactive mode with stdin for the prompt
 * (avoids Windows command line length limits).
 */

import { spawn } from "node:child_process";

const CLI_TIMEOUT_MS = 120_000;

export interface GeminiRunResult {
  text: string;
  model?: string;
}

/**
 * Runs `gemini` with the given message piped via stdin.
 * Uses --prompt for non-interactive mode.
 * The prompt is passed via stdin to avoid Windows command line length limits.
 */
export async function runGeminiPrompt(
  message: string,
  options?: {
    model?: string;
    systemPrompt?: string;
  },
): Promise<GeminiRunResult> {
  const model = options?.model || "gemini-2.5-flash";

  return new Promise((resolve, reject) => {
    const stderrChunks: string[] = [];

    // Use -p "" to enable headless mode (avoids interactive terminal).
    // The actual prompt is piped via stdin to avoid Windows command line length limits.
    const proc = spawn(
      "gemini",
      ["--model", model, "--output-format", "json", "--skip-trust", "-p", ""],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      },
    );

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

    // Build the full prompt
    let fullPrompt = message;
    if (options?.systemPrompt) {
      fullPrompt = `${options.systemPrompt}\n\n${message}`;
    }

    // Pipe the prompt via stdin
    if (proc.stdin) {
      proc.stdin.write(fullPrompt);
      proc.stdin.end();
    }

    proc.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      reject(new Error(`Gemini CLI error: ${err.message}`));
    });

    proc.on("exit", (code) => {
      if (timeout) clearTimeout(timeout);

      if (code !== 0 && code !== null) {
        const stderr = stderrChunks.join("").trim().slice(0, 500);
        reject(
          new Error(
            `Gemini CLI exited (code ${code})${stderr ? `: ${stderr}` : ""}`,
          ),
        );
        return;
      }

      try {
        // Parse JSON output - find the first { ... } JSON object
        const allOutput = stdout.trim();
        const jsonStart = allOutput.indexOf("{");
        if (jsonStart === -1) {
          reject(
            new Error(
              `No JSON response from Gemini CLI. Raw: ${allOutput.slice(0, 200)}`,
            ),
          );
          return;
        }

        const jsonStr = allOutput.slice(jsonStart);
        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        const responseText =
          typeof parsed.response === "string" ? parsed.response : "";

        resolve({ text: responseText, model });
      } catch (err) {
        reject(
          new Error(
            `Failed to parse Gemini CLI output: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });

    timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Gemini CLI timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);
  });
}
