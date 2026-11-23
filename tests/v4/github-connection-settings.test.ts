import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { Notice, setRequestUrlHandler } from "obsidian"
import { DEFAULT_SETTINGS, SettingTab } from "../../src/setting"
import { waitForCondition } from "../helpers/wait-for"

const token = "private-token-must-not-appear"
const source = { ...DEFAULT_SETTINGS, githubOwner: "owner", githubRepo: "notes",
  githubBranch: "main", githubToken: token }
const response = (status: number, json: unknown) => ({
  status, json, text: "private-token-must-not-appear", headers: {}, arrayBuffer: new ArrayBuffer(0),
})
const v4ConfigResponse = (repoId: string, mode: "plaintext" | "encrypted" = "plaintext") => {
  const bytes = Buffer.from(JSON.stringify({ formatVersion: 4, mode, repoId,
    pathLayout: mode === "encrypted" ? "opaque-stable-v1" : "plaintext-v1" }))
  const sha = createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex")
  return response(200, { encoding: "base64", content: bytes.toString("base64"), sha })
}

const v4HeadResponse = (head: unknown = {
  formatVersion: 4, mode: "plaintext", epoch: 0, generation: 1,
  journalId: "initial", shardHashes: {}, updatedAt: 1, deviceId: "device-test",
}) => {
  const bytes = Buffer.from(JSON.stringify(head))
  const sha = createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex")
  return response(200, { encoding: "base64", content: bytes.toString("base64"), sha })
}

const missingImmutablePathResponse = (url: string) => {
  if (url.includes("/git/commits/" + "a".repeat(40))) {
    return response(200, { sha: "a".repeat(40), tree: { sha: "c".repeat(40) }, parents: [] })
  }
  if (url.includes("/git/trees/" + "c".repeat(40))) {
    return response(200, { sha: "c".repeat(40), tree: [], truncated: false })
  }
  return null
}

const tabFor = () => {
  const tab = new SettingTab({} as never, {
    settings: { ...source }, clipboardReadTip: "",
  } as never)
  tab.display()
  return tab
}

const clipboardInTest = async <T>(readText: () => Promise<string>, run: () => Promise<T>): Promise<T> => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  Object.defineProperty(globalThis, "navigator", {
    configurable: true, value: { clipboard: { readText } },
  })
  try { return await run() } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original)
    else Reflect.deleteProperty(globalThis, "navigator")
  }
}

test("D423 clipboard import rejects invalid JSON fields without damaging a working Settings draft", async () => {
  const importedToken = "private-pasted-token-should-never-be-logged"
  const tab = tabFor()
  const before = structuredClone(tab.tempSettings)
  const tip = tab.containerEl.findByClass("clipboard-read-description")
  assert.ok(tip)
  await clipboardInTest(async () => JSON.stringify({
    githubOwner: { incorrect: "not-a-string" },
    githubRepo: "notes", githubToken: importedToken,
  }), async () => tab.handleClipboardPaste(tip as never))
  assert.deepEqual(tab.tempSettings, before, "malformed clipboard values must not mutate live Settings")
  assert.equal(tab.isDirty(), false, "an invalid import must not leave an accidental Save prompt")
  assert.match(tab.containerEl.flattenText(), /No configuration detected/u)
  assert.doesNotMatch(tab.containerEl.flattenText(), /private-pasted-token-should-never-be-logged/u)

  const branch = tab.containerEl.findByClass("clipboard-read-description")
  assert.ok(branch)
  await clipboardInTest(async () => JSON.stringify({
    owner: "owner", repo: "notes", token: importedToken, branch: "../main",
  }), async () => tab.handleClipboardPaste(branch as never))
  assert.deepEqual(tab.tempSettings, before)
  assert.equal(tab.isDirty(), false)
})

test("D423 clipboard import atomically accepts aliases and shows a visible, secret-free Save reminder", async () => {
  const importedToken = "private-pasted-token-should-never-be-logged"
  const settings = { ...DEFAULT_SETTINGS }
  const plugin = { settings, clipboardReadTip: "" }
  const tab = new SettingTab({} as never, plugin as never)
  tab.display()
  const tip = tab.containerEl.findByClass("clipboard-read-description")
  assert.ok(tip)
  await clipboardInTest(async () => JSON.stringify({
    owner: "new-owner", repo: "new-notes", branch: "device-notes", token: importedToken,
  }), async () => tab.handleClipboardPaste(tip as never))
  assert.equal(tab.tempSettings?.githubOwner, "new-owner")
  assert.equal(tab.tempSettings?.githubRepo, "new-notes")
  assert.equal(tab.tempSettings?.githubBranch, "device-notes")
  assert.equal(tab.tempSettings?.githubToken, importedToken)
  assert.equal(tab.isDirty(), true, "an imported configuration must require explicit Save")
  assert.deepEqual(plugin.settings, settings, "import must not publish credentials or start Sync before Save")
  assert.match(tab.containerEl.flattenText(), /Configuration pasted.*Save changes/u,
    "the confirmation must remain attached after the Settings panel redraw")
  assert.doesNotMatch(tab.containerEl.flattenText(), /private-pasted-token-should-never-be-logged/u)
  tab.hide()
  tab.display()
  assert.doesNotMatch(tab.containerEl.flattenText(), /Configuration pasted.*Save changes/u,
    "a new Settings session must not display a stale import success hint")
})

test("D423 a delayed clipboard response cannot overwrite Settings edited or closed meanwhile", async () => {
  for (const changedDuringRead of ["edited", "hidden"] as const) {
    const tab = tabFor()
    let release!: (value: string) => void
    const pending = new Promise<string>(resolve => { release = resolve })
    const tip = tab.containerEl.findByClass("clipboard-read-description")
    assert.ok(tip)
    await clipboardInTest(async () => pending, async () => {
      const importing = tab.handleClipboardPaste(tip as never)
      if (changedDuringRead === "hidden") {
        tab.hide()
      } else {
        tab.tempSettings!.githubRepo = "user-new-edit"
        tab.updateDirtyState()
      }
      release(JSON.stringify({
        owner: "stale-owner", repo: "stale-repo",
        token: "stale-credential-never-to-import",
      }))
      await importing
      assert.notEqual(tab.tempSettings?.githubRepo, "stale-repo",
        "a stale clipboard response must never replace newer user state")
      if (changedDuringRead === "hidden") {
        assert.equal(tab.tempSettings, null, "closing Settings must leave no editable draft")
      } else {
        assert.equal(tab.tempSettings?.githubRepo, "user-new-edit")
      }
      assert.doesNotMatch(tab.containerEl.flattenText(), /stale-credential-never-to-import/u)
    })
  }
})

test("D424 editing repository during a stalled connection check lets users retry without waiting", async () => {
  let releaseOld!: () => void
  const oldRequest = new Promise<void>(resolve => { releaseOld = resolve })
  const requests: string[] = []
  setRequestUrlHandler(async raw => {
    const url = (raw as { url: string }).url
    requests.push(url)
    if (url.endsWith("/repos/owner/notes")) {
      await oldRequest
      return response(200, { id: 123, full_name: "owner/notes" })
    }
    if (url.endsWith("/repos/owner/revised")) {
      return response(200, { id: 456, full_name: "owner/revised" })
    }
    if (url.includes("/repos/owner/revised/contents/.obsidian-github-sync-v4/head")) return v4HeadResponse()
    if (url.includes("/repos/owner/revised/contents/")) return v4ConfigResponse("owner/revised#main")
    return response(200, { ref: "refs/heads/main", object: { sha: "a".repeat(40), type: "commit" } })
  })
  try {
    const tab = tabFor()
    tab.containerEl.findByText("Test GitHub connection")?.onclick?.()
    await waitForCondition(() => requests.length === 1, "initial read-only GitHub request")
    assert.equal(tab.containerEl.findByText("Test GitHub connection")?.disabled, true,
      "duplicate checks for the unchanged draft should stay disabled")

    tab.tempSettings!.githubRepo = "revised"
    tab.updateDirtyState()
    const retryButton = tab.containerEl.findByText("Test GitHub connection")
    assert.equal(retryButton?.disabled, false,
      "after editing the repository, retry must be available even if the old request stalls")
    retryButton?.onclick?.()
    await waitForCondition(() => tab.containerEl.flattenText().includes("Repository and branch are accessible"),
      "new repository connection check")
    assert.deepEqual(requests.map(url => url.split("?")[0]), [
      "https://api.github.com/repos/owner/notes",
      "https://api.github.com/repos/owner/revised",
      "https://api.github.com/repos/owner/revised/git/ref/heads/main",
      "https://api.github.com/repos/owner/revised/contents/.obsidian-github-sync-v4/config.json",
      "https://api.github.com/repos/owner/revised/contents/.obsidian-github-sync-v4/head",
    ], "retry should use only the new repository and read-only GET requests")

    releaseOld()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.match(tab.containerEl.flattenText(), /Repository and branch are accessible/u,
      "a late old response must not overwrite the newer success")
    assert.doesNotMatch(tab.containerEl.flattenText(), /private-token-must-not-appear/u)
  } finally {
    releaseOld?.()
    setRequestUrlHandler(null)
  }
})

test("D449 invalid user-editable Settings show specific secret-free guidance before any Save writes", async () => {
  const sensitiveToken = "private-token-DO-NOT-LEAK"
  const sensitivePassphrase = "private-passphrase-DO-NOT-LEAK"
  const cases = [
    { field: "githubOwner", invalid: "owner with spaces", valid: "different-owner", guidance: /GitHub owner/u },
    { field: "githubRepo", invalid: "repo/path", valid: "other-notes", guidance: /GitHub repository/u },
    { field: "githubBranch", invalid: "bad..branch", valid: "feature/notes", guidance: /GitHub branch.*\.\./u },
    { field: "ignorePathRegex", invalid: "(?<private-regex-DO-NOT-LEAK>", valid: "^Archive/", guidance: /Ignore.path regex/u },
  ] as const

  for (const scenario of cases) {
    let attempts = 0
    const plugin = {
      settings: { ...source, encryptionMode: "encrypted" as const,
        githubToken: sensitiveToken, encryptionPassphrase: sensitivePassphrase },
      clipboardReadTip: "",
      async saveSettings(next: typeof plugin.settings) {
        attempts++
        plugin.settings = next
      },
      updateStatusBar() {},
    }
    const tab = new SettingTab({} as never, plugin as never)
    tab.display()
    tab.tempSettings![scenario.field] = scenario.invalid
    tab.updateDirtyState()
    assert.equal(tab.isDirty(), true)
    const noticesBefore = Notice.messages.length
    tab.containerEl.findByText("Save changes")?.onclick?.()
    await waitForCondition(() => Notice.messages.length > noticesBefore, "invalid Save guidance")
    const messages = Notice.messages.slice(noticesBefore)
    assert.ok(messages.some(message => scenario.guidance.test(message)),
      scenario.field + ": user should know which input needs fixing")
    assert.ok(messages.every(message => !message.includes(scenario.invalid)
      && !message.includes(sensitiveToken) && !message.includes(sensitivePassphrase)
      && !message.includes("private-regex-DO-NOT-LEAK")),
    "validation notices may never display raw field contents or credentials")
    assert.equal(attempts, 0, "invalid input must be rejected before secure storage or plugin Save")
    assert.equal(tab.tempSettings?.[scenario.field], scenario.invalid,
      "failed validation should not clear the user's editable draft")
    assert.equal(tab.isDirty(), true)
    tab.tempSettings![scenario.field] = scenario.valid
    tab.updateDirtyState()
    tab.containerEl.findByText("Save changes")?.onclick?.()
    await waitForCondition(() => !tab.isDirty(), "corrected user settings saved")
    assert.equal(attempts, 1, "correction should allow Save without reopening the tab")
    assert.equal(plugin.settings[scenario.field], scenario.valid)
  }
})

test("D425 failed Settings Save never exposes storage exception secrets and remains retryable", async () => {
  const passphrase = "private-passphrase-must-not-appear"
  const settings = { ...source, encryptionMode: "encrypted" as const, encryptionPassphrase: passphrase }
  let attempts = 0
  const plugin = {
    settings, clipboardReadTip: "",
    async saveSettings(next: typeof settings) {
      attempts++
      if (attempts === 1) {
        throw new Error(`Failed to store token ${token} and passphrase ${passphrase}`)
      }
      plugin.settings = next
    },
    updateStatusBar() {},
  }
  const tab = new SettingTab({} as never, plugin as never)
  tab.display()
  tab.tempSettings!.githubRepo = "new-repository"
  tab.updateDirtyState()
  const noticesBefore = Notice.messages.length
  const save = tab.containerEl.findByText("Save changes")
  assert.ok(save)
  save.onclick?.()
  await waitForCondition(() => Notice.messages.length > noticesBefore, "failed Settings Save notice")
  const failureMessages = Notice.messages.slice(noticesBefore)
  assert.ok(failureMessages.some(message => /Settings not saved/u.test(message)))
  assert.ok(failureMessages.every(message => !message.includes(token) && !message.includes(passphrase)),
    "an untrusted storage error must never expose the saved credentials")
  assert.ok(failureMessages.some(message => /retry/u.test(message)),
    "failed Save should tell the user what to do next")
  assert.equal(plugin.settings.githubRepo, "notes", "failed Save must not replace active GitHub target")
  assert.equal(tab.tempSettings?.githubRepo, "new-repository", "failed Save must preserve the user's draft")
  assert.equal(tab.isDirty(), true)

  const retry = tab.containerEl.findByText("Save changes")
  assert.ok(retry)
  retry.onclick?.()
  await waitForCondition(() => !tab.isDirty(), "retry after storage recovers")
  assert.equal(attempts, 2)
  assert.equal(plugin.settings.githubRepo, "new-repository")
  assert.ok(Notice.messages.slice(noticesBefore).every(message =>
    !message.includes(token) && !message.includes(passphrase)))
})

test("D415 Settings connection check uses unsaved credentials for read-only repository and branch requests", async () => {
  const requests: Array<{ method: string; url: string; authorization: string; body?: string }> = []
  setRequestUrlHandler(async raw => {
    const request = raw as { method: string; url: string; headers: Record<string, string>; body?: string }
    requests.push({ method: request.method, url: request.url,
      authorization: request.headers.Authorization, ...(request.body ? { body: request.body } : {}) })
    if (request.url.endsWith("/repos/owner/notes")) {
      return response(200, { id: 123, full_name: "owner/notes" })
    }
    if (request.url.includes("/contents/.obsidian-github-sync-v4/config.json")) {
      return v4ConfigResponse("owner/notes#main")
    }
    if (request.url.includes("/contents/.obsidian-github-sync-v4/head")) return v4HeadResponse()
    return response(200, { ref: "refs/heads/main", object: { sha: "a".repeat(40), type: "commit" } })
  })
  try {
    const tab = tabFor()
    const check = tab.containerEl.findByText("Test GitHub connection")
    assert.ok(check, "Settings should provide a connection check before first Sync")
    check.onclick?.()
    await waitForCondition(() => tab.containerEl.flattenText().includes("Repository and branch are accessible"),
      "read-only connection result")
    assert.equal(requests.length, 4)
    assert.ok(requests.every(r => r.method === "GET" && r.body === undefined),
      "connection check may not publish or mutate any remote content")
    assert.ok(requests.every(r => r.authorization === "Bearer " + token))
    assert.doesNotMatch(tab.containerEl.flattenText(), /private-token-must-not-appear/u)
    assert.match(tab.containerEl.flattenText(), /Save changes to use this configuration/u)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D440 existing branch preflight reads config and HEAD from one pinned commit, not the moving branch", async () => {
  const initialSha = "a".repeat(40)
  const newerSha = "b".repeat(40)
  const metadataReads: string[] = []
  let branchReads = 0
  setRequestUrlHandler(async raw => {
    const request = raw as { url: string; method: string }
    assert.equal(request.method, "GET")
    const { url } = request
    if (url.endsWith("/repos/owner/notes")) return response(200, { id: 123, full_name: "owner/notes" })
    if (url.includes("/git/ref/heads/main?")) {
      branchReads++
      return response(200, { ref: "refs/heads/main", object: { sha: branchReads === 1 ? initialSha : newerSha, type: "commit" } })
    }
    if (url.includes("/contents/.obsidian-github-sync-v4/")) {
      metadataReads.push(url)
      if (url.includes("/config.json")) return v4ConfigResponse("owner/notes#main")
      return v4HeadResponse()
    }
    throw new Error("Unexpected read")
  })
  try {
    const tab = tabFor()
    tab.containerEl.findByText("Test GitHub connection")?.onclick?.()
    await waitForCondition(() => tab.containerEl.findByText("Test GitHub connection")?.disabled === false, "GitHub preflight completes")
    assert.match(tab.containerEl.flattenText(), /Repository and branch are accessible at the checked commit/u)
    assert.match(tab.containerEl.flattenText(), /Sync will recheck GitHub/u)
    assert.equal(metadataReads.length, 2)
    assert.ok(metadataReads.every(url => new URL(url).searchParams.get("ref") === initialSha),
      "the validated V4 config and HEAD must both belong to the initially observed immutable commit")
    assert.equal(branchReads, 1, "do not inspect unrelated moving branch tips")
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D439 encrypted V4 HEAD presence stays read-only without claiming passphrase verification", async () => {
  const requests: string[] = []
  setRequestUrlHandler(async raw => {
    const { url, method } = raw as { url: string; method: string }
    assert.equal(method, "GET")
    requests.push(url)
    if (url.endsWith("/repos/owner/notes")) return response(200, { id: 123, full_name: "owner/notes" })
    if (url.includes("/git/ref/heads/main?")) {
      return response(200, { ref: "refs/heads/main", object: { sha: "a".repeat(40), type: "commit" } })
    }
    if (url.includes("/contents/.obsidian-github-sync-v4/config.json")) {
      return v4ConfigResponse("owner/notes#main", "encrypted")
    }
    if (url.includes("/contents/.obsidian-github-sync-v4/head")) return v4HeadResponse({ opaque: "not decrypted by read-only check" })
    throw new Error("Unexpected GitHub read")
  })
  try {
    const tab = tabFor()
    tab.tempSettings!.encryptionMode = "encrypted"
    tab.display()
    tab.containerEl.findByText("Test GitHub connection")?.onclick?.()
    await waitForCondition(() => tab.containerEl.flattenText().includes("Repository and branch are accessible"),
      "encrypted V4 HEAD existence check")
    assert.match(tab.containerEl.flattenText(), /not verified.*encrypted HEAD integrity or the passphrase/iu)
    assert.equal(requests.length, 4)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D439 invalid plaintext V4 HEAD gives recovery guidance, not connection success", async () => {
  const reads: string[] = []
  setRequestUrlHandler(async raw => {
    const { url, method } = raw as { url: string; method: string }
    assert.equal(method, "GET")
    reads.push(url)
    if (url.endsWith("/repos/owner/notes")) return response(200, { id: 123, full_name: "owner/notes" })
    if (url.includes("/git/ref/heads/main?")) {
      return response(200, { ref: "refs/heads/main", object: { sha: "a".repeat(40), type: "commit" } })
    }
    if (url.includes("/contents/.obsidian-github-sync-v4/config.json")) {
      return v4ConfigResponse("owner/notes#main")
    }
    if (url.includes("/contents/.obsidian-github-sync-v4/head")) {
      return v4HeadResponse({ formatVersion: 4, mode: "plaintext", generation: -1 })
    }
    throw new Error("Unexpected GitHub read")
  })
  try {
    const tab = tabFor()
    tab.containerEl.findByText("Test GitHub connection")?.onclick?.()
    await waitForCondition(() => tab.containerEl.findByText("Test GitHub connection")?.disabled === false,
      "invalid HEAD verification completes")
    const message = tab.containerEl.flattenText()
    assert.match(message, /invalid head metadata/iu)
    assert.match(message, /new empty branch/iu)
    assert.doesNotMatch(message, /Repository and branch are accessible|private-token-must-not-appear/iu)
    assert.equal(reads.length, 4)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D439 existing V4 config without HEAD is not ready for first Sync", async () => {
  const requests: Array<{ method: string; url: string }> = []
  setRequestUrlHandler(async raw => {
    const request = raw as { method: string; url: string }
    requests.push(request)
    if (request.url.endsWith("/repos/owner/notes")) return response(200, { id: 123, full_name: "owner/notes" })
    if (request.url.includes("/git/ref/heads/main?")) {
      return response(200, { ref: "refs/heads/main", object: { sha: "a".repeat(40), type: "commit" } })
    }
    if (request.url.includes("/contents/.obsidian-github-sync-v4/config.json")) {
      return v4ConfigResponse("owner/notes#main")
    }
    if (request.url.includes("/contents/.obsidian-github-sync-v4/head")) {
      return response(404, { message: token })
    }
    const fallback = missingImmutablePathResponse(request.url)
    if (fallback) return fallback
    throw new Error("Unexpected GitHub read")
  })
  try {
    const tab = tabFor()
    tab.containerEl.findByText("Test GitHub connection")?.onclick?.()
    await waitForCondition(() => tab.containerEl.findByText("Test GitHub connection")?.disabled === false,
      "existing V4 metadata check completes")
    const message = tab.containerEl.flattenText()
    assert.match(message, /V4.*head.*missing/iu)
    assert.match(message, /new empty branch/iu)
    assert.doesNotMatch(message, /Repository and branch are accessible|Force Push first|private-token-must-not-appear/iu)
    assert.equal(requests.length, 6, "missing immutable HEAD falls back to the Git tree for reliable absence")
    assert.ok(requests.every(r => r.method === "GET"), "read-only connection check must never mutate GitHub")
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D438 existing branch without V4 config warns before first Sync instead of certifying readiness", async () => {
  const requests: Array<{ method: string; url: string }> = []
  setRequestUrlHandler(async raw => {
    const request = raw as { method: string; url: string }
    requests.push({ method: request.method, url: request.url })
    if (request.url.endsWith("/repos/owner/notes")) {
      return response(200, { id: 123, full_name: "owner/notes" })
    }
    if (request.url.includes("/git/ref/heads/main?")) {
      return response(200, { ref: "refs/heads/main", object: { sha: "a".repeat(40), type: "commit" } })
    }
    if (request.url.includes("/contents/.obsidian-github-sync-v4/config.json")) {
      return response(404, { message: token })
    }
    const fallback = missingImmutablePathResponse(request.url)
    if (fallback) return fallback
    throw new Error("Unexpected GitHub request")
  })
  try {
    const tab = tabFor()
    tab.containerEl.findByText("Test GitHub connection")?.onclick?.()
    await waitForCondition(() => tab.containerEl.findByText("Test GitHub connection")?.disabled === false,
      "read-only check completes")
    const text = tab.containerEl.flattenText()
    assert.match(text, /no V4 (configuration|config)/iu)
    assert.match(text, /new empty branch/iu)
    assert.doesNotMatch(text, /Repository and branch are accessible|Force Push first|private-token-must-not-appear/iu)
    assert.ok(requests.every(request => request.method === "GET"), "connection test must remain read-only")
    assert.equal(requests.length, 5, "missing immutable config falls back to commit and Git tree for reliable absence")
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D438 connection check warns on mismatched V4 storage mode and repository identity", async () => {
  const cases = [
    { mode: "encrypted" as const, repoId: "owner/notes#main", expected: /uses encrypted storage, but Settings use plaintext/u },
    { mode: "plaintext" as const, repoId: "other/notes#main", expected: /different repository identity/u },
  ]
  for (const scenario of cases) {
    const requests: string[] = []
    setRequestUrlHandler(async raw => {
      const request = raw as { method: string; url: string }
      assert.equal(request.method, "GET")
      requests.push(request.url)
      if (request.url.endsWith("/repos/owner/notes")) return response(200, { id: 123, full_name: "owner/notes" })
      if (request.url.includes("/git/ref/heads/main?")) {
        return response(200, { ref: "refs/heads/main", object: { sha: "a".repeat(40), type: "commit" } })
      }
      if (request.url.includes("/contents/.obsidian-github-sync-v4/config.json")) {
        return v4ConfigResponse(scenario.repoId, scenario.mode)
      }
      throw new Error("Unexpected GitHub request")
    })
    try {
      const tab = tabFor()
      tab.containerEl.findByText("Test GitHub connection")?.onclick?.()
      await waitForCondition(() => tab.containerEl.findByText("Test GitHub connection")?.disabled === false,
        "V4 compatibility check completes")
      const rendered = tab.containerEl.flattenText()
      assert.match(rendered, scenario.expected)
      assert.doesNotMatch(rendered, /Repository and branch are accessible|private-token-must-not-appear/u)
      assert.equal(requests.length, 3)
    } finally {
      setRequestUrlHandler(null)
    }
  }
})

test("D438 changing encryption mode during a V4 config read revokes the old success", async () => {
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  setRequestUrlHandler(async raw => {
    const url = (raw as { url: string }).url
    if (url.endsWith("/repos/owner/notes")) return response(200, { id: 123, full_name: "owner/notes" })
    if (url.includes("/git/ref/heads/main?")) {
      return response(200, { ref: "refs/heads/main", object: { sha: "a".repeat(40), type: "commit" } })
    }
    if (url.includes("/contents/.obsidian-github-sync-v4/config.json")) {
      entered()
      await gate
      return v4ConfigResponse("owner/notes#main")
    }
    throw new Error("Unexpected GitHub request")
  })
  try {
    const tab = tabFor()
    tab.containerEl.findByText("Test GitHub connection")?.onclick?.()
    await waiting
    tab.tempSettings!.encryptionMode = "encrypted"
    tab.display()
    assert.equal(tab.containerEl.findByText("Test GitHub connection")?.disabled, false,
      "the changed mode should immediately permit a new check")
    release()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.match(tab.containerEl.flattenText(), /Connection settings changed.*Test again/u)
    assert.doesNotMatch(tab.containerEl.flattenText(), /Repository and branch are accessible/u)
  } finally {
    release?.()
    setRequestUrlHandler(null)
  }
})

test("D420 Settings distinguishes the local device ID from the remote GitHub repository", () => {
  const tab = tabFor()
  const visible = tab.containerEl.flattenText()
  assert.match(visible, /Device ID \(this Obsidian vault\)/u)
  assert.match(visible, /not the GitHub repository name/u)
  assert.match(visible, /different ID on each device/u)
  assert.doesNotMatch(visible, /Remote repository name/u,
    "this setting is used for local device identity, not the remote repository")
})

test("D422 Settings Sync and force actions never target saved GitHub settings while edits are unsaved", () => {
  const operations: string[] = []
  const settings = { ...source }
  const plugin = {
    settings,
    clipboardReadTip: "",
    v4Runtime: {
      manualSync: async () => { operations.push("manual-sync") },
    },
    runSyncFromUi(operation: () => Promise<unknown>) {
      operations.push("observed-ui-sync")
      void operation()
    },
    showForceConfirm(kind: string) { operations.push(kind) },
  }
  const tab = new SettingTab({} as never, plugin as never)
  tab.display()
  const action = (label: string) => {
    const button = tab.containerEl.findByText(label)
    assert.ok(button, `Settings must show ${label}`)
    button.onclick?.()
  }
  const noticesBefore = Notice.messages.length
  tab.tempSettings!.githubRepo = "different-repository"
  tab.updateDirtyState()
  action("Sync now")
  action("Force push")
  action("Force pull")
  assert.deepEqual(operations, [], "pending drafts must not trigger work against the prior GitHub repository")
  const notices = Notice.messages.slice(noticesBefore)
  assert.equal(notices.length, 3, "every rejected operation should explain why it was skipped")
  assert.ok(notices.every(message => /Save or discard.*settings/u.test(message)))
  assert.ok(notices.every(message => !message.includes(token)), "warnings must not expose tokens")

  tab.tempSettings = { ...settings }
  tab.display()
  action("Sync now")
  action("Force push")
  action("Force pull")
  assert.deepEqual(operations, ["observed-ui-sync", "manual-sync", "forcePush", "forcePull"],
    "saved Settings must use the observed UI Sync path and retain confirm-gated force actions")
})

test("D422 Settings manual actions stay blocked while an asynchronous Save is pending", async () => {
  const operations: string[] = []
  const settings = { ...source }
  let saveStarted!: () => void
  let releaseSave!: () => void
  const started = new Promise<void>(resolve => { saveStarted = resolve })
  const savingGate = new Promise<void>(resolve => { releaseSave = resolve })
  const plugin = {
    settings,
    clipboardReadTip: "",
    v4Runtime: { manualSync: async () => { operations.push("manual-sync") } },
    runSyncFromUi(operation: () => Promise<unknown>) {
      operations.push("observed-ui-sync")
      void operation()
    },
    showForceConfirm(kind: string) { operations.push(kind) },
    async saveSettings(next: typeof settings) {
      saveStarted()
      await savingGate
      plugin.settings = next
    },
    updateStatusBar() {},
  }
  const tab = new SettingTab({} as never, plugin as never)
  tab.display()
  try {
    tab.tempSettings!.githubRepo = "new-saved-repository"
    tab.updateDirtyState()
    assert.ok(tab.isDirty())
    const save = tab.containerEl.findByText("Save changes")
    assert.ok(save)
    save.onclick?.()
    await started
    for (const label of ["Sync now", "Force push", "Force pull"]) {
      tab.containerEl.findByText(label)?.onclick?.()
    }
    assert.deepEqual(operations, [], "an unresolved Settings Save cannot be bypassed by manual buttons")
    releaseSave()
    await waitForCondition(() => !tab.isDirty(), "Settings commit finishes before manual Sync")
    tab.containerEl.findByText("Sync now")?.onclick?.()
    assert.deepEqual(operations, ["observed-ui-sync", "manual-sync"])
  } finally {
    releaseSave?.()
  }
})

test("D415 missing branch and inaccessible private repository receive distinct safe instructions", async () => {
  let status = 404
  setRequestUrlHandler(async raw => {
    const url = (raw as { url: string }).url
    if (url.endsWith("/repos/owner/notes")) return response(status,
      status === 200 ? { id: 123, full_name: "owner/notes" } : { message: token })
    return response(404, { message: token })
  })
  try {
    const tab = tabFor()
    const first = tab.containerEl.findByText("Test GitHub connection")
    assert.ok(first)
    first.onclick?.()
    await waitForCondition(() => tab.containerEl.flattenText().includes("Repository is not accessible"),
      "private repo failure")
    assert.doesNotMatch(tab.containerEl.flattenText(), /private-token-must-not-appear/u)
    status = 200
    const second = tab.containerEl.findByText("Test GitHub connection")
    assert.ok(second)
    second.onclick?.()
    await waitForCondition(() => tab.containerEl.flattenText().includes("Configured branch was not found"),
      "missing branch status")
    assert.match(tab.containerEl.flattenText(), /Save changes, then press Sync now to create the branch/u,
      "a missing branch is a supported first-run state, not a reason to perform a force operation")
    assert.match(tab.containerEl.flattenText(), /not verified write permission/u,
      "the read-only connection check cannot promise that a token can create the branch")
    assert.doesNotMatch(tab.containerEl.flattenText(), /private-token-must-not-appear/u)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D415 invalid token and incomplete draft never produce a false-positive connection result", async () => {
  let calls = 0
  setRequestUrlHandler(async () => { calls++; return response(401, { message: token }) })
  try {
    const tab = tabFor()
    tab.containerEl.findByText("Test GitHub connection")?.onclick?.()
    await waitForCondition(() => tab.containerEl.flattenText().includes("GitHub rejected the token"),
      "invalid token guidance")
    assert.equal(calls, 1)
    assert.doesNotMatch(tab.containerEl.flattenText(), /private-token-must-not-appear/u)
    tab.hide()

    const unconfigured = new SettingTab({} as never, {
      settings: { ...DEFAULT_SETTINGS }, clipboardReadTip: "",
    } as never)
    unconfigured.display()
    unconfigured.containerEl.findByText("Test GitHub connection")?.onclick?.()
    await waitForCondition(() => unconfigured.containerEl.flattenText().includes("Enter a GitHub owner"),
      "incomplete form guidance")
    assert.equal(calls, 1, "missing mandatory fields must not send a GitHub request")
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D415 delayed GitHub response cannot certify a connection after changing the Settings draft or hiding the tab", async () => {
  let resume!: () => void
  let signalStarted!: () => void
  const started = new Promise<void>(resolve => { signalStarted = resolve })
  const gate = new Promise<void>(resolve => { resume = resolve })
  let resumeSecond!: () => void
  let secondStarted!: () => void
  const secondGate = new Promise<void>(resolve => { resumeSecond = resolve })
  const secondRequestStarted = new Promise<void>(resolve => { secondStarted = resolve })
  let calls = 0
  setRequestUrlHandler(async () => {
    calls++
    if (calls === 2) {
      secondStarted()
      await secondGate
    } else {
      signalStarted()
      await gate
    }
    return response(200, { id: 123, full_name: "owner/notes" })
  })
  try {
    const tab = tabFor()
    const check = tab.containerEl.findByText("Test GitHub connection")
    assert.ok(check)
    check.onclick?.()
    await started
    tab.tempSettings!.githubRepo = "another-repo"
    tab.display()
    resume()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(calls, 1)
    assert.doesNotMatch(tab.containerEl.flattenText(), /Repository and branch are accessible/u)

    const tab2 = tabFor()
    const check2 = tab2.containerEl.findByText("Test GitHub connection")
    assert.ok(check2)
    check2.onclick?.()
    await secondRequestStarted
    tab2.hide()
    resumeSecond()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(calls, 2, "hidden tab must not send a follow-up branch request")
    assert.doesNotMatch(tab2.containerEl.flattenText(), /Repository and branch are accessible/u)
  } finally {
    resume?.()
    resumeSecond?.()
    setRequestUrlHandler(null)
  }
})
