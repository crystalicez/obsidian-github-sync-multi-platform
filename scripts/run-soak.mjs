import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const GiB = 1024 ** 3;
const bytesArg = process.argv.slice(2).find(arg => arg.startsWith("--bytes="));
const sizes = (bytesArg ? bytesArg.slice("--bytes=".length).split(",") : [String(2 * GiB), String(5 * GiB)])
  .map(value => Number(value.trim()))
  .filter(value => Number.isSafeInteger(value) && value > 0);
if (sizes.length === 0) {
  console.error("No valid soak sizes were provided.");
  process.exit(2);
}
const chunkArg = process.argv.slice(2).find(arg => arg.startsWith("--chunk-bytes="));
for (const logicalBytes of sizes) {
  console.log(`\n=== V4 cryptographic soak: ${logicalBytes} bytes ===`);
  const env = { ...process.env, V4_RUN_SOAK: "1", V4_SOAK_BYTES: String(logicalBytes) };
  if (chunkArg) env.V4_SOAK_CHUNK_BYTES = chunkArg.slice("--chunk-bytes=".length);
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "run-tests.mjs"), "--tier=soak"], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}
