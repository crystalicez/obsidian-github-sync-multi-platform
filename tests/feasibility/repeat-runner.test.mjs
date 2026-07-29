import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("repeat runner does not require a pnpm executable on PATH", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "v4-repeat-runner-"));
  const scripts = path.join(fixture, "scripts");
  await mkdir(scripts, { recursive: true });
  await copyFile(path.join(repoRoot, "scripts", "run-test-repeat.mjs"), path.join(scripts, "run-test-repeat.mjs"));

  const countFile = path.join(fixture, "count.txt");
  await writeFile(
    path.join(scripts, "run-tests.mjs"),
    `import { appendFile } from "node:fs/promises";\nawait appendFile(${JSON.stringify(countFile)}, "run\\n");\n`,
    "utf8",
  );

  const result = spawnSync(process.execPath, [path.join(scripts, "run-test-repeat.mjs")], {
    cwd: fixture,
    env: { ...process.env, PATH: "", TEST_REPEAT: "2" },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(await readFile(countFile, "utf8"), "run\nrun\n");
});
