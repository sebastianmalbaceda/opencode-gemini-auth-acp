/**
 * Debug ACP - logs every message from the CLI.
 * Run: bun run test-acp-debug.ts
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

async function main() {
  const proc = spawn("gemini", ["--acp"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  if (!proc.stdin || !proc.stdout) throw new Error("No pipes");

  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[STDERR] ${d}`));

  const rl = createInterface({ input: proc.stdout });
  const send = (msg: unknown) => proc.stdin!.write(JSON.stringify(msg) + "\n");

  let msgCount = 0;
  let sessionId = "";

  rl.on("line", (line: string) => {
    const t = line.trim();
    if (!t) return;
    msgCount++;
    try {
      const p = JSON.parse(t);
      const hasId = "id" in p;
      const hasMethod = "method" in p;

      if (hasId && hasMethod) {
        // Inbound request from CLI
        console.log(`\n[${msgCount}] <<< REQ ${p.method} id=${p.id}`);
        console.log(
          `    params keys: ${p.params ? Object.keys(p.params).join(", ") : "none"}`,
        );
      } else if (hasId && !hasMethod) {
        // Response to our request
        const result = p.result || {};
        const keys = Object.keys(result);
        console.log(
          `\n[${msgCount}] >>> RESP id=${p.id} keys=[${keys.join(", ")}]`,
        );
        if (result.stopReason)
          console.log(`    stopReason: ${result.stopReason}`);
        if (result.sessionId) {
          sessionId = result.sessionId;
          console.log(`    sessionId: ${result.sessionId}`);
        }
        if (result._meta) {
          const usage = result._meta?.quota?.token_count;
          if (usage) console.log(`    tokens: ${JSON.stringify(usage)}`);
        }
        // Print full response preview
        console.log(`    raw: ${JSON.stringify(p).slice(0, 500)}`);
      } else if (hasMethod && !hasId) {
        // Notification
        const params = p.params || {};
        const pType = params.type || "?";
        const content = params.content || {};
        const cType = content.type || "?";
        const text = content.text || "";
        console.log(
          `\n[${msgCount}] <<< NOTIF ${p.method} type=${pType} content=${cType} text="${text.slice(0, 80)}"`,
        );
      }
    } catch {
      console.log(`[${msgCount}] NON-JSON: ${t.slice(0, 100)}`);
    }
  });

  // Wait for startup
  await sleep(2000);

  // 1. Initialize
  console.log("\n=== INIT ===");
  send({
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientInfo: { name: "test", version: "1.0" },
    },
    id: 1,
  });
  await sleep(8000);

  // 2. Authenticate
  console.log("\n=== AUTH ===");
  send({
    jsonrpc: "2.0",
    method: "authenticate",
    params: { methodId: "oauth-personal" },
    id: 2,
  });
  await sleep(3000);

  const acpCwd = join(tmpdir(), "acp-empty");
  try {
    mkdirSync(acpCwd, { recursive: true });
  } catch {}
  // 3. Create session with writable empty temp dir
  console.log(`\n=== SESSION NEW (cwd=${acpCwd}) ===`);
  send({
    jsonrpc: "2.0",
    method: "session/new",
    params: { cwd: acpCwd, mcpServers: [] },
    id: 3,
  });
  await sleep(5000);

  // 4. Prompt
  console.log("\n=== PROMPT ===");
  send({
    jsonrpc: "2.0",
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: "Say hello in one word." }],
    },
    id: 4,
  });
  await sleep(20000);

  proc.kill();
  console.log("\n=== DONE ===");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
main().catch(console.error);
