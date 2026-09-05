import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("stable release stays fail-closed until Child A provenance promotion lands", async () => {
  const text = await readFile(resolve(".github/workflows/release.yml"), "utf8");
  assert.match(text, /permissions:\s*\n\s*actions:\s*read\s*\n\s*contents:\s*read/u);

  const interlock = text.indexOf("Block stable release until Child A provenance gate lands");
  const checkout = text.indexOf("actions/checkout@");
  assert.ok(interlock >= 0, "temporary Child A release interlock must exist");
  assert.ok(checkout > interlock, "interlock must fail before repository checkout");

  const block = text.slice(interlock, checkout);
  assert.match(block, /Release Provenance/u);
  assert.match(block, /exit 1/u);
});
