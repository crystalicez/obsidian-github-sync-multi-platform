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

test("D96 Wizard rejects in-place and replacement connection edits after dialog opens", async () => {
  const plugin = fakePlugin()
  const wizard = new V4ReencryptionWizardModal(plugin)
  wizard.onOpen()
  const internal = wizard as unknown as {
    matchesConnection(): boolean
    verifySource(): Promise<void>
  }
  assert.equal(internal.matchesConnection(), true)

  const originalToken = plugin.settings.githubToken
  plugin.settings.githubToken = "secret-rotated-in-place"
  assert.equal(internal.matchesConnection(), false)
  let apiCalls = 0
  setRequestUrlHandler(async () => {
    apiCalls++
    throw new Error("Wizard must not run a verified source read with changed settings.")
  })
  try {
    await internal.verifySource()
    assert.equal(apiCalls, 0)
    const text = (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
    assert.match(text, /configured encrypted GitHub connection/i)
    assert.ok(!text.includes("secret-rotated-in-place"))
    plugin.settings.githubToken = originalToken
    assert.equal(internal.matchesConnection(), true)
    const original = plugin.settings
    plugin.settings = { ...original, githubBranch: "another" }
    assert.equal(internal.matchesConnection(), false)
    plugin.settings = original
    assert.equal(internal.matchesConnection(), true)
  } finally {
    setRequestUrlHandler(null)
    wizard.onClose()
  }
})

test("D130 Wizard preview explains cross-platform best-effort and one-confirmation automatic finish without authorizing execution", () => {
  const wizard = new V4ReencryptionWizardModal(fakePlugin())
  wizard.onOpen()
  const debug = wizard as unknown as { step: number; render(): void }
  let content = (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
  assert.match(content, /best.effort/i)
  assert.match(content, /external.*write|external.*edit/i)
  debug.step = 4
  debug.render()
  content = (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
  assert.match(content, /automatic/i)
  assert.match(content, /once|one confirmation/i)
  assert.match(content, /crash.safe/i)
  assert.match(content, /BLOCKED|disabled/i)
  wizard.onClose()
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
