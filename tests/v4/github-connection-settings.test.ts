import assert from "node:assert/strict"
import test from "node:test"
import { setRequestUrlHandler } from "obsidian"
import { DEFAULT_SETTINGS, SettingTab } from "../../src/setting"
import { waitForCondition } from "../helpers/wait-for"

const token = "private-token-must-not-appear"
const source = { ...DEFAULT_SETTINGS, githubOwner: "owner", githubRepo: "notes",
  githubBranch: "main", githubToken: token }
const response = (status: number, json: unknown) => ({
  status, json, text: "private-token-must-not-appear", headers: {}, arrayBuffer: new ArrayBuffer(0),
})
const tabFor = () => {
  const tab = new SettingTab({} as never, {
    settings: { ...source }, clipboardReadTip: "",
  } as never)
  tab.display()
  return tab
}

test("D415 Settings connection check uses unsaved credentials for read-only repository and branch requests", async () => {
  const requests: Array<{ method: string; url: string; authorization: string; body?: string }> = []
  setRequestUrlHandler(async raw => {
    const request = raw as { method: string; url: string; headers: Record<string, string>; body?: string }
    requests.push({ method: request.method, url: request.url,
      authorization: request.headers.Authorization, ...(request.body ? { body: request.body } : {}) })
    if (request.url.endsWith("/repos/owner/notes")) {
      return response(200, { id: 123, full_name: "owner/notes" })
    }
    return response(200, { ref: "refs/heads/main", object: { sha: "a".repeat(40), type: "commit" } })
  })
  try {
    const tab = tabFor()
    const check = tab.containerEl.findByText("Test GitHub connection")
    assert.ok(check, "Settings should provide a connection check before first Sync")
    check.onclick?.()
    await waitForCondition(() => tab.containerEl.flattenText().includes("Repository and branch are accessible"),
      "read-only connection result")
    assert.equal(requests.length, 2)
    assert.ok(requests.every(r => r.method === "GET" && r.body === undefined),
      "connection check may not publish or mutate any remote content")
    assert.ok(requests.every(r => r.authorization === "Bearer " + token))
    assert.doesNotMatch(tab.containerEl.flattenText(), /private-token-must-not-appear/u)
    assert.match(tab.containerEl.flattenText(), /Save changes to use this configuration/u)
  } finally {
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
