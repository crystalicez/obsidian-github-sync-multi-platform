import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repeats = Number(process.env.TEST_REPEAT ?? 10);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100) {
  console.error(`Invalid TEST_REPEAT: ${process.env.TEST_REPEAT ?? ""}`);
  process.exit(2);
}

const testRunner = fileURLToPath(new URL("./run-tests.mjs", import.meta.url));

for (let run = 1; run <= repeats; run++) {
  console.log(`\n=== fast test repeat ${run}/${repeats} ===`);
  const result = spawnSync(process.execPath, [testRunner, "--tier=fast"], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
