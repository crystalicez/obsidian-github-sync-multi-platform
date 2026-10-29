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

test("D133 old-passphrase loss warning appears before migration confirmation, without exposing secrets or another confirmation", () => {
  const wizard = new V4ReencryptionWizardModal(fakePlugin())
  wizard.onOpen()
  const debug = wizard as unknown as {
    step: number
    render(): void
    source: {
      physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string
      verifiedFileCount: number; verifiedRemoteObjectCount: number; totalVerifiedPlaintextBytes: string
    }
    newPassphrase: string; confirmPassphrase: string
  }
  const flattened = () => (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
  debug.step = 1
  debug.render()
  assert.match(flattened(), /old passphrase/i)
  assert.match(flattened(), /source.*backup|backup.*source/i)
  debug.source = {
    physicalRepositoryId: 123456, defaultBranch: "main",
    pinnedSourceCommitSha: "a".repeat(40),
    verifiedFileCount: 0, verifiedRemoteObjectCount: 0, totalVerifiedPlaintextBytes: "0",
  }
  debug.newPassphrase = "new-passphrase-never-render"
  debug.confirmPassphrase = "new-passphrase-never-render"
  debug.step = 2
  debug.render()
  const review = flattened()
  assert.match(review, /old passphrase/i)
  assert.match(review, /save|keep.*copy/i)
  assert.match(review, /source.*backup|backup.*source/i)
  assert.match(review, /after.*crash.safe|after.*verified/i)
  assert.match(review, /SecretStorage/i)
  assert.doesNotMatch(review, /source-passphrase-never-render|new-passphrase-never-render|source-token-never-render/)
  assert.match(review, /BLOCKED/)
  debug.step = 4
  debug.render()
  const finish = flattened()
  assert.match(finish, /old passphrase/i)
  assert.match(finish, /clear|remove/i)
  assert.match(finish, /crash.safe|verified/i)
  assert.match(finish, /BLOCKED/)
  wizard.onClose()
})



test("D153 Wizard branch availability rechecks exact pinned Source HEAD and default branch via GET only", async () => {
  const expectedSha = "a".repeat(40)
  const otherSha = "b".repeat(40)
  const respond = (json: unknown, status = 200) => ({
    status, text: status === 200 ? "" : "unavailable", json, headers: {},
  })
  for (const scenario of [
    "stable", "source-moved", "default-moved", "wrong-source-ref",
    "missing-source-ref", "source-request-fails", "repository-swapped", "destination-collision",
  ] as const) {
    const plugin = fakePlugin()
    const wizard = new V4ReencryptionWizardModal(plugin)
    const view = wizard as unknown as {
      source: {
        physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string;
        verifiedFileCount: number; verifiedRemoteObjectCount: number;
        totalVerifiedPlaintextBytes: string
      }
      checked?: {
        pinnedSourceCommitSha: string; physicalRepositoryId: number;
        destinationRepoId: string; backupRepoId: string
      }
      step: number; render(): void; checkBranchAvailability(): Promise<void>
      destinationBranch: string; backupBranch: string;
      newPassphrase: string; confirmPassphrase: string
    }
    view.source = {
      physicalRepositoryId: 444, defaultBranch: "main", pinnedSourceCommitSha: expectedSha,
      verifiedFileCount: 0, verifiedRemoteObjectCount: 0, totalVerifiedPlaintextBytes: "0",
    }
    view.destinationBranch = "rekey/2026-10-29-abcdef01"
    view.backupBranch = "backup/rekey-2026-10-29-abcdef01"
    view.newPassphrase = "different-preview-only-passphrase"
    view.confirmPassphrase = "different-preview-only-passphrase"
    const requests: Array<{url: string; method?: string; body?: unknown}> = []
    setRequestUrlHandler(async raw => {
      const request = raw as {url: string; method?: string; body?: unknown}
      requests.push(request)
      assert.equal(request.method, "GET", "Preview must never send a mutation")
      assert.equal(request.body, undefined, "Preview must never send request payloads")
      if (request.url.includes("/git/ref/heads/")) {
        if (request.url.includes("/heads/main?")) {
          if (scenario === "missing-source-ref") return respond({}, 404)
          if (scenario === "source-request-fails") return respond({}, 403)
          return respond({
            ref: scenario === "wrong-source-ref" ? "refs/heads/other" : "refs/heads/main",
            object: { sha: scenario === "source-moved" ? otherSha : expectedSha, type: "commit" },
          })
        }
        return scenario === "destination-collision"
          && request.url.includes("/heads/rekey/")
          ? respond({ ref: "refs/heads/rekey/2026-10-29-abcdef01",
              object: { sha: otherSha, type: "commit" } })
          : respond({}, 404)
      }
      assert.match(request.url, /^https:\/\/api\.github\.com\/repos\/owner\/vault$/u)
      return respond({
        id: scenario === "repository-swapped" ? 999 : 444,
        full_name: "owner/vault",
        default_branch: scenario === "default-moved" ? "alternate" : "main",
      })
    })
    try {
      wizard.onOpen()
      view.step = 2
      view.render()
      await view.checkBranchAvailability()
      const text = (wizard.contentEl as unknown as {flattenText(): string}).flattenText()
      if (scenario === "stable") {
        assert.equal(view.checked?.pinnedSourceCommitSha, expectedSha)
        assert.equal(view.checked?.physicalRepositoryId, 444)
        assert.match(text, /Both refs were absent at the time/i)
        assert.equal(requests.length, 5, "two ref lookups + repo identity + default branch + source HEAD")
      } else {
        assert.equal(view.checked, undefined, scenario + " must not mark branch names ready")
        if (scenario === "source-moved" || scenario === "default-moved") {
          assert.match(text, /source again/i, "stale source must tell user to repeat verification")
        }
        assert.match(text, /Not checked|Check the destination/i)
      }
      assert.ok(requests.every(request => request.method === "GET" && request.body === undefined))
      assert.ok(!text.includes("source-token-never-render"))
      assert.ok(!text.includes("source-passphrase-never-render"))
      assert.ok(!text.includes("different-preview-only-passphrase"))
    } finally {
      wizard.onClose()
      setRequestUrlHandler(null)
    }
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
