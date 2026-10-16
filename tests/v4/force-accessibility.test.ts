import assert from "node:assert/strict";
import test from "node:test";

import FastSync from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/setting";
import { ElementStub, modalEvents, modalInstances, Notice, resetModalTestState } from "../stubs/obsidian";

function openForceConfirmation(operation: "forcePush" | "forcePull") {
  resetModalTestState();
  Notice.messages.length = 0;
  const calls: string[] = [];
  let generation = 1;
  const plugin = new FastSync() as FastSync & Record<string, any>;
  plugin.settings = {
    ...DEFAULT_SETTINGS,
    githubOwner: "owner",
    githubRepo: "private-notes",
    githubBranch: "safe-branch",
    githubToken: "test-token",
  };
  plugin.manifest = { id: "encrypted-github-sync-multi-platform" };
  plugin.app = { vault: { configDir: ".obsidian", getFiles: () => [] } };
  plugin.v4Runtime = {
    get settingsGeneration() { return generation; },
    forcePush() { calls.push("push"); },
    forcePull() { calls.push("pull"); },
  };
  const finished = plugin.showForceConfirm(operation);
  const modal = modalInstances.at(-1);
  assert.ok(modal, "configured operation opens a modal");
  const slider = modal.contentEl.findByClass("github-sync-force-confirm-slider");
  const button = modal.contentEl.findByText(operation === "forcePush" ? "Force push" : "Force pull");
  assert.ok(slider, "confirmation slider is visible");
  assert.ok(button, "force action exists");
  return {
    modal, slider, button, calls, finished,
    changeGeneration() { generation++; },
  };
}

function pressKey(slider: ElementStub, key: string): number {
  let prevented = 0;
  slider.onkeydown?.({
    key,
    preventDefault() { prevented++; },
  } as KeyboardEvent);
  return prevented;
}

for (const operation of ["forcePush", "forcePull"] as const) {
  test(`${operation} requires accessible keyboard unlock and a separate confirmed click`, async () => {
    const fixture = openForceConfirmation(operation);
    const { slider, button, calls } = fixture;
    assert.equal(slider.attributes.role, "slider");
    assert.equal(slider.attributes.tabindex, "0");
    assert.equal(slider.attributes["aria-valuemin"], "0");
    assert.equal(slider.attributes["aria-valuemax"], "100");
    assert.equal(slider.attributes["aria-valuenow"], "0");
    assert.match(slider.attributes["aria-label"] ?? "", /owner\/private-notes.*safe-branch/u);
    assert.equal(button.style.display, "none");
    button.onclick?.();
    assert.deepEqual(calls, []);
    assert.equal(pressKey(slider, "Enter"), 0, "Enter must not silently unlock");
    assert.equal(pressKey(slider, " "), 0, "Space must not silently unlock");

    for (let i = 0; i < 9; i++) assert.equal(pressKey(slider, "ArrowRight"), 1);
    assert.equal(slider.attributes["aria-valuenow"], "90");
    assert.equal(button.style.display, "none");
    assert.equal(pressKey(slider, "ArrowLeft"), 1);
    assert.equal(slider.attributes["aria-valuenow"], "80");
    assert.equal(pressKey(slider, "Home"), 1);
    assert.equal(slider.attributes["aria-valuenow"], "0");
    for (let i = 0; i < 10; i++) pressKey(slider, "ArrowRight");
    assert.equal(slider.attributes["aria-valuenow"], "100");
    assert.equal(button.style.display, "");
    assert.match(slider.attributes["aria-valuetext"], /unlocked/iu);
    assert.deepEqual(calls, [], "unlock alone never starts destructive action");
    button.onclick?.();
    await fixture.finished;
    assert.deepEqual(calls, [operation === "forcePush" ? "push" : "pull"]);
    assert.equal(modalEvents.at(-1), "close", "confirmed action closes the dialog");
    button.onclick?.();
    assert.equal(calls.length, 1, "duplicate click is harmless");
  });

  test(`${operation} retains safe pointer unlock and rejects settings changed before click`, async () => {
    const fixture = openForceConfirmation(operation);
    const { slider, button, calls } = fixture;
    slider.onpointerdown?.({ pointerId: 1, clientX: 35 } as PointerEvent);
    slider.onpointerup?.({ pointerId: 1, clientX: 35 } as PointerEvent);
    assert.equal(slider.attributes["aria-valuenow"], "0", "abandoned drag resets accessible value");
    assert.equal(button.style.display, "none");

    slider.onpointerdown?.({ pointerId: 2, clientX: 40 } as PointerEvent);
    slider.onpointermove?.({ pointerId: 2, clientX: 300 } as PointerEvent);
    slider.onpointerup?.({ pointerId: 2, clientX: 300 } as PointerEvent);
    assert.equal(slider.attributes["aria-valuenow"], "100");
    assert.equal(button.style.display, "");
    fixture.changeGeneration();
    button.onclick?.();
    await fixture.finished;
    assert.deepEqual(calls, [], "stale target confirmation must never execute");
    assert.match(Notice.messages.at(-1) ?? "", /settings changed/iu);
  });

  test(`${operation} cancel never invokes a force operation even after keyboard End`, async () => {
    const fixture = openForceConfirmation(operation);
    assert.equal(pressKey(fixture.slider, "End"), 1);
    assert.equal(fixture.slider.attributes["aria-valuenow"], "100");
    assert.equal(fixture.button.style.display, "");
    fixture.modal.contentEl.findByText("Cancel")?.onclick?.();
    await fixture.finished;
    assert.deepEqual(fixture.calls, []);
  });
}

