/**
 * Fast Gemini CLI prompt via subprocess (gemini -p).
 * Used for simple chat requests. ~10s vs ~60s for Code Assist API.
 */

import { spawn } from "node:child_process";

const TIMEOUT_MS = 120_000;

export interface GeminiRunResult {
  text: string;
  model?: string;
}

export async function runGeminiPrompt(
  message: string,
  options?: { model?: string; systemPrompt?: string },
): Promise<GeminiRunResult> {
  const model = options?.model || "gemini-2.5-flash";

  return new Promise((resolve, reject) => {
    const stderr: string[] = [];
    const proc = spawn(
      "gemini",
      ["--model", model, "--output-format", "json", "--skip-trust", "-p", ""],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } },
    );

    let stdout = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer) => { stderr.push(chunk.toString()); });

    let fullPrompt = message;
    if (options?.systemPrompt) fullPrompt = `${options.systemPrompt}\n\n${message}`;

    if (proc.stdin) { proc.stdin.write(fullPrompt); proc.stdin.end(); }

    proc.on("error", (err) => { if (timer) clearTimeout(timer); reject(new Error(`Gemini error: ${err.message}`)); });

    proc.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0 && code !== null) {
        return reject(new Error(`Gemini CLI exited (code ${code}): ${stderr.join("").trim().slice(0, 300)}`));
      }
      try {
        const all = stdout.trim();
        const start = all.indexOf("{");
        if (start === -1) return reject(new Error("No JSON response"));
        const parsed = JSON.parse(all.slice(start)) as Record<string, unknown>;
        const text = typeof parsed.response === "string" ? parsed.response : "";
        resolve({ text, model });
      } catch (err) {
        reject(new Error(`Parse error: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

    timer = setTimeout(() => { proc.kill(); reject(new Error("Gemini CLI timed out")); }, TIMEOUT_MS);
  });
}
