import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const MAX_TEST_BYTES = 100_000_000;
const bytesArg = process.argv.slice(2).find(arg => arg.startsWith("--bytes="));
const sizes = (bytesArg ? bytesArg.slice("--bytes=".length).split(",") : [String(MAX_TEST_BYTES)])
  .map(value => Number(value.trim()));
if (sizes.length === 0 || sizes.some(value => !Number.isSafeInteger(value) || value <= 0 || value > MAX_TEST_BYTES)) {
  console.error(`Soak sizes must be positive safe integers no larger than ${MAX_TEST_BYTES} bytes.`);
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
