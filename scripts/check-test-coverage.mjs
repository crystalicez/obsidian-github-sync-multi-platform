import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const requiredModules = [
  "bytes",
  "change-queue",
  "conflicts",
  "constants",
  "crypto",
  "ignore",
  "large-objects",
  "manifest-store",
  "paths",
  "remote-state",
  "settings-policy",
  "pack-format",
  "pack-planner",
  "pack-sync",
  "scale-policy",
  "sync-engine",
  "sync-planner",
  "sync-errors",
  "snapshot-store",
  "snapshot-merge",
  "snapshot-types",
  "types",
  "vault",
];

const testFiles = [
  "tests/encrypted/actual-behavior.test.ts",
  "tests/encrypted/error-handling.test.ts",
  "tests/encrypted/e2e-sync.test.ts",
  "tests/encrypted/benchmark.test.ts",
  "tests/encrypted/settings-combinations.test.ts",
  "tests/encrypted/pack-planner.test.ts",
  "tests/encrypted/snapshot-store.test.ts",
  "tests/encrypted/snapshot-merge.test.ts",
  "tests/encrypted/change-queue.test.ts",
  "tests/encrypted/sync-planner.test.ts",
  "tests/encrypted-v3/protocol-core.test.ts",
  "tests/encrypted-v3/sync-session.test.ts",
  "tests/encrypted-v3/store-modules.test.ts",
];

const contents = await Promise.all(testFiles.map(file => readFile(path.join(root, file), "utf8")));
const joined = contents.join("\n");
const missing = requiredModules.filter(moduleName => !joined.includes(`src/lib/encrypted/${moduleName}`) && !joined.includes(`../../src/lib/encrypted/${moduleName}`));

if (missing.length > 0) {
  console.error(`Missing encrypted module test references: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`Encrypted module coverage gate passed for ${requiredModules.length}/${requiredModules.length} modules.`);

const requiredV3Modules = [
  "binary-format",
  "change-batcher",
  "keyring",
  "local-index",
  "object-store",
  "paths",
  "protocol-types",
  "shard-store",
  "sync-session",
];
const missingV3 = requiredV3Modules.filter(moduleName => !joined.includes(`src/lib/encrypted-v3/${moduleName}`) && !joined.includes(`../../src/lib/encrypted-v3/${moduleName}`));

if (missingV3.length > 0) {
  console.error(`Missing encrypted-v3 module test references: ${missingV3.join(", ")}`);
  process.exit(1);
}

console.log(`Encrypted-v3 module coverage gate passed for ${requiredV3Modules.length}/${requiredV3Modules.length} modules.`);
