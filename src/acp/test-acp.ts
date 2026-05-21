/**
 * ACP debug test - logs all messages.
 * Run: bun run src/acp/test-acp.ts
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

async function main() {
  const proc = spawn("gemini", ["--acp"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  if (!proc.stdin || !proc.stdout) throw new Error("No pipes");

  // Capture stderr
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(d));

  const rl = createInterface({ input: proc.stdout });
  const send = (msg: unknown) => proc.stdin!.write(JSON.stringify(msg) + "\n");

  let msgCount = 0;
  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    msgCount++;
    try {
      const parsed = JSON.parse(trimmed);
      const isMsg = "method" in parsed;
      const isResp = "id" in parsed && !("method" in parsed);
      const type = isMsg
        ? `MSG:${parsed.method}`
        : isResp
          ? `RESP(id=${parsed.id})`
          : `NOTIF:${parsed.method}`;
      const text = type.includes("content_chunk") ? "" : "";
      const preview = JSON.stringify(parsed).slice(0, 200);
      console.log(`[${msgCount}] ${type}${text ? " " + text : ""}`);
      if (!type.includes("content_chunk")) {
        console.log(`  ${preview}`);
      }
    } catch {
      console.log(`[${msgCount}] NON-JSON: ${trimmed.slice(0, 100)}`);
    }
  });

  await sleep(1000);

  // 1. Initialize
  console.log("\n--- INIT ---");
  send({
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientInfo: { name: "test", version: "1.0" },
    },
    id: 1,
  });
  await sleep(7000);

  // 2. Authenticate
  console.log("\n--- AUTH ---");
  send({
    jsonrpc: "2.0",
    method: "authenticate",
    params: { methodId: "oauth-personal" },
    id: 2,
  });
  await sleep(3000);

  // 3. Session new
  console.log("\n--- SESSION ---");
  send({
    jsonrpc: "2.0",
    method: "session/new",
    params: { cwd: "C:\\Windows\\Temp", mcpServers: [] },
    id: 3,
  });
  await sleep(5000);

  proc.kill();
  console.log("\nDone");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch(console.error);
