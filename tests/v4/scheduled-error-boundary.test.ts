import assert from "node:assert/strict";
import test from "node:test";
import { Platform } from "obsidian";
import FastSync from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/setting";

test("scheduled sync rejection is handled by Obsidian timer without leaking error text", async () => {
  const originalPlatform = Platform.isDesktopApp;
  const originals = {
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    warn: console.warn,
  };
  const setGlobal = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const restoreGlobal = (name: string, original?: PropertyDescriptor) => {
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  };
  let tick!: () => void;
  const cleared: number[] = [];
  const warnings: string[] = [];
  let calls = 0;
  try {
    Platform.isDesktopApp = false;
    setGlobal("window", {
      setInterval: (callback: () => void, milliseconds: number) => {
        assert.equal(milliseconds, 30_000);
        tick = callback;
        return 17;
      },
      clearInterval: (handle: number) => cleared.push(handle),
    });
    setGlobal("navigator", { onLine: true });
    setGlobal("document", { hidden: false });
    console.warn = (...messages) => warnings.push(messages.map(String).join(" "));
    const plugin = new FastSync();
    plugin.settings = {
      ...DEFAULT_SETTINGS, syncEnabled: true, scheduledSyncEnabled: true,
      scheduledSyncIntervalSeconds: 30,
      githubOwner: "test", githubRepo: "vault", githubToken: "synthetic-secret",
    };
    plugin.v4Runtime = {
      settingsGeneration: 4,
      scheduledSync: async () => { calls++; throw Error("synthetic-secret in rejection"); },
    } as any;
    plugin.registerScheduledSync();
    tick();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.deepEqual(warnings, ["GitHub Sync: scheduled reconciliation failed."]);
    assert.ok(!warnings[0].includes("synthetic-secret"));
    plugin.settings.scheduledSyncEnabled = false;
    plugin.registerScheduledSync();
    assert.deepEqual(cleared, [17]);
  } finally {
    Platform.isDesktopApp = originalPlatform;
    restoreGlobal("window", originals.window);
    restoreGlobal("navigator", originals.navigator);
    restoreGlobal("document", originals.document);
    console.warn = originals.warn;
  }
});
