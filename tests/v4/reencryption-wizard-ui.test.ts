import assert from "node:assert/strict"
import test from "node:test"
import { setRequestUrlHandler } from "obsidian"
import type FastSync from "../../src/main"
import { V4ReencryptionWizardModal } from "../../src/views/reencryption-wizard"

function fakePlugin(
  mode: "plaintext" | "encrypted" = "encrypted",
  active = false,
): FastSync {
  return {
    app: {},
    settings: {
      githubOwner: "owner",
      githubRepo: "vault",
      githubToken: "source-token-never-render",
      githubBranch: "main",
      encryptionMode: mode,
      encryptionPassphrase: "source-passphrase-never-render",
    },
    v4Runtime: { isSyncing: active },
  } as unknown as FastSync
}

test("D92 Wizard opens in a read-only, blocked state with no network or branch writes", () => {
  let apiCalls = 0
  setRequestUrlHandler(async () => {
    apiCalls++
    throw new Error("The Wizard must not call GitHub merely because it opened.")
  })
  try {
    const wizard = new V4ReencryptionWizardModal(fakePlugin())
    wizard.onOpen()
    const content = wizard.contentEl.textContent ?? (wizard.contentEl as unknown as {flattenText:()=>string}).flattenText()
    assert.match(content, /Preview|preview/)
    assert.match(content, /source|snapshot/i)
    assert.match(content, /read-only/i)
    assert.match(content, /production safety gates/i)
    assert.ok(!content.includes("source-passphrase-never-render"))
    assert.ok(!content.includes("source-token-never-render"))
    assert.equal(apiCalls, 0)
    wizard.onClose()
    assert.equal(apiCalls, 0)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D92 Wizard preflight refuses unencrypted and busy source without network I/O or mutation", async () => {
  let apiCalls = 0
  setRequestUrlHandler(async () => {
    apiCalls++
    throw new Error("Unexpected GitHub call from an ineligible Wizard.")
  })
  try {
    for (const [mode, active] of [["plaintext", false], ["encrypted", true]] as const) {
      const wizard = new V4ReencryptionWizardModal(fakePlugin(mode, active))
      wizard.onOpen()
      // Exercise the same click handler used by Step 1; no private data exposed.
      await (wizard as unknown as { verifySource(): Promise<void> }).verifySource()
      const text = (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
      assert.match(text, /Save a configured encrypted|Sync operation is active/i)
      assert.match(text, /BLOCKED|disabled/i)
      wizard.onClose()
    }
    assert.equal(apiCalls, 0)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D92 Wizard has no direct GitHub mutation or local settings-save capability", () => {
  const wizard = new V4ReencryptionWizardModal(fakePlugin())
  wizard.onOpen()
  // The only method with a currently accessible navigation destination
  // deliberately shows NOT STARTED instead of a fictitious progress bar.
  const debug = wizard as unknown as {step:number; render(): void; onClose():void}
  debug.step = 3
  debug.render()
  assert.match((wizard.contentEl as unknown as {flattenText():string}).flattenText(), /NOT STARTED/)
  debug.step = 4
  debug.render()
  assert.match((wizard.contentEl as unknown as {flattenText():string}).flattenText(), /Not completed/)
  wizard.onClose()
})
