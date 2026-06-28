import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const requiredModules = [
  "bytes",
  "conflicts",
  "constants",
  "crypto",
  "ignore",
  "large-objects",
  "manifest-store",
  "paths",
  "remote-state",
  "settings-policy",
  "sync-engine",
  "sync-errors",
  "types",
  "vault",
];

const testFiles = [
  "tests/encrypted/actual-behavior.test.ts",
  "tests/encrypted/error-handling.test.ts",
  "tests/encrypted/e2e-sync.test.ts",
  "tests/encrypted/benchmark.test.ts",
  "tests/encrypted/settings-combinations.test.ts",
];

const contents = await Promise.all(testFiles.map(file => readFile(path.join(root, file), "utf8")));
const joined = contents.join("\n");
const missing = requiredModules.filter(moduleName => !joined.includes(`src/lib/encrypted/${moduleName}`) && !joined.includes(`../../src/lib/encrypted/${moduleName}`));

if (missing.length > 0) {
  console.error(`Missing encrypted module test references: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`Encrypted module coverage gate passed for ${requiredModules.length}/${requiredModules.length} modules.`);
