/**
 * Quick ACP test to measure response time.
 * Run: bun run src/acp/test-acp.ts
 */

import { AcpClient } from "./client";

async function main() {
  console.log("Starting ACP test...\n");

  const start = Date.now();

  console.log("1. Creating ACP client...");
  const client = await AcpClient.create();

  console.log(`   → ${Date.now() - start}ms\n2. Initializing...`);
  const info = await client.initialize();
  console.log(`   → Agent: ${info.agentInfo.name} v${info.agentInfo.version}`);
  console.log(`   → ${Date.now() - start}ms\n3. Authenticating...`);

  await client.authenticate();
  console.log(`   → ${Date.now() - start}ms\n4. Creating session...`);

  const sessionId = await client.createSession();
  console.log(`   → Session: ${sessionId}`);
  console.log(`   → ${Date.now() - start}ms\n5. Sending prompt...`);

  // Register streaming
  client.onStream((chunk: string) => {
    process.stdout.write(chunk);
  });

  const promptStart = Date.now();
  const result = await client.sendPrompt(sessionId, "Say hello in one word.");
  const promptTime = Date.now() - promptStart;

  console.log(`\n   → Prompt completed in ${promptTime}ms`);
  console.log(`   → Total: ${Date.now() - start}ms`);
  console.log(`   → Usage: ${JSON.stringify(result.usage)}`);

  console.log("\n6. Cleaning up...");
  await client.destroy();
  console.log("Done!");
}

main().catch((err) => {
  console.error("ACP test failed:", err);
  process.exit(1);
});
