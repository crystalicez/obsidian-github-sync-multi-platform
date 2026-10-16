import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const { compile } = createRequire(import.meta.url)("sass") as typeof import("sass");

const source = readFileSync(resolve("src/styles.scss"), "utf8");
const distributed = readFileSync(resolve("styles.css"), "utf8");

test("generated stylesheet stays LF on Windows checkouts", () => {
  const attributes = readFileSync(resolve(".gitattributes"), "utf8");
  assert.match(attributes, /^styles\.css text eol=lf\s*$/mu);
});

test("tracked styles.css is exactly reproducible from the pinned Sass compiler", () => {
  const expected = compile(resolve("src/styles.scss"), { style: "expanded", sourceMap: false }).css;
  assert.equal(distributed.replace(/\r\n/gu, "\n").trimEnd(), expected.trimEnd(), "Published CSS has drifted from Sass source. Run pnpm build:css.");
});

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

test("Sync Center responds to its containing sidebar instead of the full desktop window", () => {
  for (const css of [source, distributed]) {
    assert.match(css, /\.github-sync-center\s*\{[^}]*container-type:\s*inline-size/su);
    assert.match(css, /@container\s*\(max-width:\s*640px\)/u);
    assert.match(css, /\.github-sync-center__layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/su);
  }
});

test("mobile CSS stacks the settings dirty-state buttons in narrow viewports", () => {
  for (const css of [source, distributed]) {
    assert.match(css, /@media\s*\(max-width:\s*480px\)/u);
    assert.match(css, /\.github-sync-settings-dirty-banner/u);
    assert.match(css, /\.github-sync-settings-dirty-buttons/u);
  }
});
