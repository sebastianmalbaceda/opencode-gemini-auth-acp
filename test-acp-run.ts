/**
 * Quick ACP test to measure response time.
 * Run: bun run test-acp-run.ts
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

async function main() {
  console.log("Starting ACP test...\n");

  const proc = spawn("gemini", ["--acp"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!proc.stdin || !proc.stdout) {
    throw new Error("Failed to spawn");
  }

  const rl = createInterface({ input: proc.stdout });

  const send = (msg: unknown) => {
    proc.stdin!.write(JSON.stringify(msg) + "\n");
  };

  const waitForResponse = (timeoutMs = 15000): Promise<string> => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout")), timeoutMs);
      rl.once("line", (line: string) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  };

  const totalStart = Date.now();
  let t = totalStart;

  // 1. Initialize
  send({
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientInfo: { name: "test", version: "1.0" },
    },
    id: 1,
  });
  const initResp = JSON.parse(await waitForResponse(20000));
  console.log(`1. Initialize: ${Date.now() - t}ms`);
  t = Date.now();
  console.log(
    `   Agent: ${initResp.result?.agentInfo?.name} v${initResp.result?.agentInfo?.version}`,
  );

  // 2. Authenticate
  send({
    jsonrpc: "2.0",
    method: "authenticate",
    params: { methodId: "oauth-personal" },
    id: 2,
  });
  const authResp = JSON.parse(await waitForResponse(15000));
  console.log(
    `2. Authenticate: ${Date.now() - t}ms (${authResp.error ? "FAILED" : "OK"})`,
  );
  t = Date.now();

  // 3. Create session
  send({
    jsonrpc: "2.0",
    method: "session/new",
    params: { cwd: process.cwd(), mcpServers: [] },
    id: 3,
  });
  const sessionResp = JSON.parse(await waitResponseN(rl, 20000));
  console.log(`3. Session: ${Date.now() - t}ms`);
  t = Date.now();

  const sessionId = sessionResp.result?.sessionId;
  console.log(`   Session ID: ${sessionId}`);

  if (!sessionId) {
    console.log("   Error:", JSON.stringify(sessionResp));
    proc.kill();
    return;
  }

  // 4. Send prompt
  // ACP prompt expects content blocks directly (not wrapped in {role, content})
  const promptMsg = {
    jsonrpc: "2.0",
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: "Say hello in one word." }],
    },
    id: 4,
  };
  send(promptMsg);

  // Wait for prompt response - may arrive after some streaming notifications
  let promptResp = null;
  const promptStart = Date.now();
  for (let i = 0; i < 10; i++) {
    const line = await Promise.race([
      new Promise<string>((r) => rl.once("line", r)),
      new Promise<string>((_, r) => setTimeout(() => r("TIMEOUT"), 5000)),
    ]);
    if (line === "TIMEOUT") break;
    try {
      const parsed = JSON.parse(line);
      if (parsed.id === 4) {
        promptResp = parsed;
        break;
      }
      // It's a notification or other message
      if (parsed.method === "session/update") {
        const content = parsed.params?.content;
        if (content?.type === "text") process.stdout.write(content.text);
      }
    } catch {}
  }

  const promptTime = Date.now() - promptStart;
  console.log(`\n4. Prompt: ${promptTime}ms`);
  t = Date.now();

  if (promptResp?.error) {
    console.log(`   Error: ${JSON.stringify(promptResp.error)}`);
  } else if (promptResp?.result) {
    console.log(`   Stop reason: ${promptResp.result.stopReason}`);
    console.log(`   Usage: ${JSON.stringify(promptResp.result.usage)}`);
  }

  console.log(`\nTotal time: ${Date.now() - totalStart}ms`);
  proc.kill();
}

async function waitResponseN(
  rl: ReturnType<typeof createInterface>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout")), timeoutMs);
    rl.once("line", (line: string) => {
      clearTimeout(timer);
      resolve(line);
    });
  });
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
