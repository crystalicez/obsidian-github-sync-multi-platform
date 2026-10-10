import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve("src/styles.scss"), "utf8");
const distributed = readFileSync(resolve("styles.css"), "utf8");

test("published stylesheet includes the settings dirty-state UI shipped by the TypeScript view", () => {
  for (const className of [
    ".github-sync-settings-header",
    ".github-sync-settings-dirty-banner",
    ".github-sync-settings-dirty-text",
    ".github-sync-settings-dirty-buttons",
    ".github-sync-center__layout",
    ".github-sync-force-confirm-slider",
  ]) {
    assert.ok(source.includes(className), `missing source style ${className}`);
    assert.ok(distributed.includes(className), `shipping stylesheet omitted ${className}`);
  }
});

test("plugin SCSS never globally changes unrelated Markdown reading/editing images", () => {
  assert.doesNotMatch(source, /(?:^|\n)\s*\.markdown-(?:rendered|source-view)\s+img\b/iu);
  assert.doesNotMatch(source, /(?:^|\n)\s*\.markdown-(?:rendered|source-view)[^\n]*img\b/iu);
  assert.doesNotMatch(distributed, /(?:^|\n)\s*\.markdown-(?:rendered|source-view)[^\n]*img\b/iu);
});

test("Sync Center layouts wrap header actions and long changed paths on small screens", () => {
  for (const css of [source, distributed]) {
    assert.match(css, /\.github-sync-center__actions\s*\{[^}]*flex-wrap:\s*wrap/su);
    assert.match(css, /\.github-sync-center__change\s+span:last-child\s*\{[^}]*overflow-wrap:\s*anywhere/su);
  }
});

test("mobile CSS stacks the settings dirty-state buttons in narrow viewports", () => {
  for (const css of [source, distributed]) {
    assert.match(css, /@media\s*\(max-width:\s*480px\)/u);
    assert.match(css, /\.github-sync-settings-dirty-banner/u);
    assert.match(css, /\.github-sync-settings-dirty-buttons/u);
  }
});
