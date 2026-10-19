import assert from "node:assert/strict";
import test from "node:test";
import { Notice } from "obsidian";

import { DEFAULT_SETTINGS, SettingTab } from "../../src/setting";
import { ElementStub } from "../stubs/obsidian";

async function withDebugUI(writeText: (text: string) => Promise<void>, check: (button: ElementStub, written: string[]) => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const written: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { navigator: { clipboard: {
      async writeText(text: string) { written.push(text); await writeText(text); },
    } } },
  });
  Notice.messages.length = 0;
  try {
    const plugin = {
      settings: { ...DEFAULT_SETTINGS, githubToken: "PRIVATE_TOKEN", encryptionPassphrase: "PRIVATE_PASSPHRASE" },
      manifest: { version: "1.0.8" },
      clipboardReadTip: "",
    };
    const tab = new SettingTab({} as never, plugin as never);
    tab.display();
    const button = (tab.containerEl as unknown as ElementStub).findByText("Copy debug information");
    assert.ok(button);
    await check(button, written);
    tab.hide();
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("Settings debug copy announces success only after clipboard write and sanitizes credentials", async () => {
  await withDebugUI(async () => undefined, async (button, written) => {
    await button.onclick?.();
    assert.equal(written.length, 1);
    assert.doesNotMatch(written[0], /PRIVATE_TOKEN|PRIVATE_PASSPHRASE/u);
    assert.match(written[0], /HIDDEN/u);
    assert.match(Notice.messages.at(-1) ?? "", /copied|success/iu);
  });
});

test("Settings debug copy handles unavailable clipboard without an unhandled rejection or false success", async () => {
  await withDebugUI(async () => { throw new Error("denied"); }, async (button) => {
    await assert.doesNotReject(Promise.resolve(button.onclick?.()));
    assert.match(Notice.messages.at(-1) ?? "", /could not|failed|denied|not available/iu);
    assert.doesNotMatch(Notice.messages.at(-1) ?? "", /copied/iu);
  });
});
