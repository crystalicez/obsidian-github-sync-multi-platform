import assert from "node:assert/strict";
import test from "node:test";
import { Notice } from "obsidian";

import { DEFAULT_SETTINGS, SettingTab } from "../../src/setting";
import { ElementStub } from "../stubs/obsidian";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

function clipboardFixture() {
  const requests: Array<ReturnType<typeof deferred<string>>> = [];
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        readText() {
          const pending = deferred<string>();
          requests.push(pending);
          return pending.promise;
        },
      },
    },
  });

  const plugin = { settings: { ...DEFAULT_SETTINGS }, clipboardReadTip: "" };
  const tab = new SettingTab({} as never, plugin as never);
  tab.tempSettings = { ...DEFAULT_SETTINGS };
  let redraws = 0;
  tab.display = () => { redraws++; };
  const tip = new ElementStub();

  return {
    tab, plugin, tip, requests,
    get redraws() { return redraws; },
    restore() {
      tab.hide();
      if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
      else Reflect.deleteProperty(globalThis, "navigator");
    },
  };
}

test("stale clipboard configuration cannot overwrite a reopened settings form", async () => {
  const f = clipboardFixture();
  try {
    const original = f.tab.handleClipboardPaste(f.tip as never);
    assert.equal(f.requests.length, 1);
    f.tab.hide();
    f.tab.tempSettings = { ...DEFAULT_SETTINGS, githubOwner: "new-owner", githubRepo: "new-repo" };
    f.requests[0].resolve(JSON.stringify({ githubOwner: "old-owner", githubRepo: "old-repo", githubToken: "old-token" }));
    await original;

    assert.equal(f.tab.tempSettings.githubOwner, "new-owner");
    assert.equal(f.tab.tempSettings.githubRepo, "new-repo");
    assert.equal(f.tab.tempSettings.githubToken, "");
    assert.equal(f.redraws, 0);
    assert.equal(f.tip.text, "");
  } finally { f.restore(); }
});

test("only newest clipboard request can modify settings when responses complete out of order", async () => {
  const f = clipboardFixture();
  try {
    const old = f.tab.handleClipboardPaste(f.tip as never);
    const latest = f.tab.handleClipboardPaste(f.tip as never);
    f.requests[1].resolve(JSON.stringify({ owner: "latest", repo: "latest-repo", token: "latest-token" }));
    await latest;
    f.requests[0].resolve(JSON.stringify({ owner: "stale", repo: "stale-repo", token: "stale-token" }));
    await old;
    assert.equal(f.tab.tempSettings!.githubOwner, "latest");
    assert.equal(f.tab.tempSettings!.githubRepo, "latest-repo");
    assert.equal(f.tab.tempSettings!.githubToken, "latest-token");
    assert.equal(f.redraws, 1);
  } finally { f.restore(); }
});

test("clipboard cannot overwrite user edits made while permission/read was pending", async () => {
  const f = clipboardFixture();
  try {
    const pending = f.tab.handleClipboardPaste(f.tip as never);
    f.tab.tempSettings!.githubOwner = "typed-after-click";
    f.requests[0].resolve(JSON.stringify({ owner: "clipboard-owner", repo: "repo", token: "token" }));
    await pending;
    assert.equal(f.tab.tempSettings!.githubOwner, "typed-after-click");
    assert.equal(f.tab.tempSettings!.githubToken, "");
    assert.equal(f.redraws, 0);
    assert.match(f.tip.text, /Settings changed while reading/iu);
  } finally { f.restore(); }
});

test("clipboard JSON with non-string GitHub coordinates or token is rejected atomically", async () => {
  const f = clipboardFixture();
  try {
    const original = { ...f.tab.tempSettings };
    const pending = f.tab.handleClipboardPaste(f.tip as never);
    f.requests[0].resolve(JSON.stringify({ owner: 23, repo: "repo", token: { secret: "not-a-string" }, branch: ["main"] }));
    await pending;
    assert.deepEqual(f.tab.tempSettings, original);
    assert.equal(f.redraws, 0);
    assert.match(f.tip.text, /No configuration detected/iu);
  } finally { f.restore(); }
});
