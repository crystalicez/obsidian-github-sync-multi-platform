import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["scripts/run-tests.mjs", "--tier=soak"], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
