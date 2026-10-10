import assert from "node:assert/strict";
import test from "node:test";

import FastSync from "../../src/main";
import { DEFAULT_SETTINGS, SettingTab } from "../../src/setting";
import { ElementStub } from "../stubs/obsidian";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

function fixture() {
  const plugin = new FastSync() as FastSync & Record<string, any>;
  const secrets = new Map<string, string>([
    ["original-token", "original"],
    ["original-passphrase", "passphrase"],
  ]);
  let quiesceCalls = 0;
  let finishedCalls = 0;
  let persistCalls = 0;
  let failNextPersist = false;
  let failNextQuiesce = false;
  const block = deferred();
  let blockNextPersist = true;

  plugin.settings = {
    ...DEFAULT_SETTINGS,
    githubOwner: "owner",
    githubRepo: "repo",
    githubToken: "original",
    githubTokenSecretId: "original-token",
    encryptionPassphrase: "passphrase",
    encryptionPassphraseSecretId: "original-passphrase",
  };
  plugin.app = {
    secretStorage: {
      getSecret(id: string) { return secrets.get(id) ?? null; },
      setSecret(id: string, value: string) { secrets.set(id, value); },
    },
  };
  plugin.v4Runtime = {
    async quiesceForSettingsChange() {
      quiesceCalls++;
      if (failNextQuiesce) {
        failNextQuiesce = false;
        throw new Error("quiesce failed");
      }
    },
    finishSettingsChange() { finishedCalls++; },
    credentialsChanged() {},
  };
  plugin.saveData = async () => {
    persistCalls++;
    if (blockNextPersist) {
      blockNextPersist = false;
      await block.promise;
    }
    if (failNextPersist) {
      failNextPersist = false;
      throw new Error("disk error");
    }
  };
  plugin.initGitHubClient = () => undefined;
  plugin.registerScheduledSync = () => undefined;
  plugin.updateRibbonIcon = () => undefined;

  return {
    plugin, secrets, block,
    get quiesceCalls() { return quiesceCalls; },
    get finishedCalls() { return finishedCalls; },
    get persistCalls() { return persistCalls; },
    failPersistence() { failNextPersist = true; },
    failQuiesce() { failNextQuiesce = true; },
    async release() { block.resolve(); },
  };
}

test("settings save rejects overlapping submissions before any second credential mutation", async () => {
  const v = fixture();
  const first = v.plugin.saveSettings({ ...v.plugin.settings, githubToken: "first-token" });
  const second = v.plugin.saveSettings({ ...v.plugin.settings, githubToken: "second-token" })
    .then(() => "accepted", error => error);
  try {
    await Promise.resolve();
    assert.equal(v.quiesceCalls, 1, "a second save must not enter settings transition");
    assert.equal(v.persistCalls, 1, "a second save must not initiate concurrent durable persistence");
  } finally {
    await v.release();
  }
  await first;
  const result = await second;
  assert.match(String(result), /already.*progress|in progress|busy/iu);
  assert.equal(v.plugin.settings.githubToken, "first-token");
  assert.equal(v.finishedCalls, 1);
  assert.equal(v.secrets.get(v.plugin.settings.githubTokenSecretId), "first-token");
  assert.equal(v.secrets.get("original-token"), "", "previous token is scrubbed only after the committed save");
});

test("settings UI prevents double-click save while the first save is pending", async () => {
  const gate = deferred();
  let calls = 0;
  const plugin = {
    clipboardReadTip: "",
    settings: { ...DEFAULT_SETTINGS },
    async saveSettings() { calls++; await gate.promise; },
    updateStatusBar() {},
  };
  const tab = new SettingTab({} as never, plugin as never);
  tab.tempSettings = { ...DEFAULT_SETTINGS, githubRepo: "new-repo" };
  tab.bannerEl = new ElementStub() as never;
  tab.display = () => undefined;
  tab.updateDirtyState();
  const save = (tab.bannerEl as unknown as ElementStub).findByText("Save changes");
  assert.ok(save);
  save.onclick?.();
  save.onclick?.();
  assert.equal(calls, 1, "a second click must not start another save");
  assert.equal(save.disabled, true, "save control must show its pending state");
  tab.updateDirtyState();
  const rerenderedSave = (tab.bannerEl as unknown as ElementStub).findByText("Save changes");
  const rerenderedDiscard = (tab.bannerEl as unknown as ElementStub).findByText("Discard");
  assert.ok(rerenderedSave && rerenderedDiscard);
  assert.equal(rerenderedSave.disabled, true, "re-rendering while save is pending must not reenable Save");
  assert.equal(rerenderedDiscard.disabled, true, "Discard must not imply it can undo a pending save");
  rerenderedSave.onclick?.();
  rerenderedDiscard.onclick?.();
  assert.equal(calls, 1);
  assert.equal(tab.tempSettings.githubRepo, "new-repo");
  gate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(save.disabled, false, "the control must become reusable after success");
});

test("quiescence failure also releases the plugin settings save guard", async () => {
  const v = fixture();
  v.failQuiesce();
  await assert.rejects(
    v.plugin.saveSettings({ ...v.plugin.settings, githubToken: "initial-failure" }),
    /quiesce failed/u,
  );
  assert.equal(v.persistCalls, 0);
  await v.release();
  await v.plugin.saveSettings({ ...v.plugin.settings, githubToken: "recovery" });
  assert.equal(v.plugin.settings.githubToken, "recovery");
  assert.equal(v.finishedCalls, 1);
});

test("failed settings save releases the save guard and allows a later retry", async () => {
  const v = fixture();
  v.failPersistence();
  const first = v.plugin.saveSettings({ ...v.plugin.settings, githubToken: "not-persisted" });
  await v.release();
  await assert.rejects(first, /disk error/u);
  assert.equal(v.plugin.settings.githubToken, "original");
  await v.plugin.saveSettings({ ...v.plugin.settings, githubToken: "retried" });
  assert.equal(v.plugin.settings.githubToken, "retried");
  assert.equal(v.finishedCalls, 2);
});
