import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workflowDir = resolve(".github/workflows");

test("external workflow actions are full-SHA pinned", async () => {
  const failures = [];
  const files = (await readdir(workflowDir)).filter(name => /\.ya?ml$/u.test(name)).sort();
  for (const file of files) {
    const text = await readFile(resolve(workflowDir, file), "utf8");
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      const match = line.match(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/u);
      if (!match || match[1].startsWith("./")) continue;
      if (!/^[^@\s]+@[0-9a-f]{40}$/u.test(match[1])) failures.push(`${file}:${index + 1}: ${match[1]}`);
    }
  }
  assert.deepEqual(failures, []);
});
