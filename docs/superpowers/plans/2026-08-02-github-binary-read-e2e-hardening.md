# GitHub Binary Read and Real-E2E Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make encrypted binary reads correct against the real GitHub Contents API, remove the flaky rate-limit timing assertion, and make the live E2E report enough transport data to evaluate speed without exposing secrets.

**Architecture:** Keep the existing Contents API fast path for valid small text/metadata payloads. Validate base64-decoded Contents bytes against the Git blob SHA; only fetch the canonical Git Blob bytes when validation detects GitHub's binary transformation. Keep the live E2E on its dedicated destructive branch, add safe elapsed/transport metrics, and retain the existing cleanup and protected-branch guards.

**Tech Stack:** TypeScript, Node `node:test`, Obsidian `requestUrl`, GitHub REST Git Data/Contents APIs, Web Crypto SHA-1 for Git blob identity, existing V4 transport metrics.

## Global Constraints

- Do not add runtime dependencies; `package.json` currently has no runtime dependencies.
- Do not log GitHub tokens, passphrases, logical paths, file contents, or raw encrypted bytes.
- Preserve the dedicated-branch guard and `finally` cleanup in the real GitHub E2E.
- Preserve the existing one-request fast path when Contents bytes match the returned Git blob SHA.
- Keep the pre-existing `docs/images/kofi.png` and `docs/images/qrcode.png` deletions out of all commits.
- Do not claim full encrypted live round-trip success until `npm run test:github-e2e:quick` reaches its final Force Pull assertions and cleanup.
- Treat large-file/pack benchmarks as a separate qualification workload; do not label the current small smoke test as a large-file performance result.

---

## Current Evidence and Scope

- `npm run test:github-e2e:quick` reached the live repository and failed after 46.1 seconds; branch cleanup was verified.
- A direct GitHub probe showed a 37-byte binary Git Blob becoming 56 bytes through the Contents API's base64 `content` field, while `/git/blobs/{sha}` returned the original 37 bytes.
- `V4SyncSession.readRecord()` and encrypted journal reads consume `getFileBytes()`, so the mismatch is a production correctness issue, not only an E2E assertion issue.
- The repeat runner also exposed a nondeterministic test assertion: the scheduler requested 1,999 ms while the test expected exactly 2,000 ms.
- Local resource/feasibility/64 MiB soak checks passed, but the live E2E currently does not emit request counts, bytes, retry/cooldown data, or per-mode elapsed time.

## File Map

- `src/lib/github-api.ts`: validate Contents-decoded bytes against Git blob identity and fall back to canonical blob bytes only on mismatch.
- `tests/v4/github-transport.test.ts`: cover binary Contents corruption, preserve the valid-text one-request fast path, and make retry timing deterministic.
- `tests/github-e2e/v4-real-github-e2e.test.ts`: retain binary Contents-vs-Blob verification and print safe per-mode timing/transport metrics.
- `docs/github-e2e.md`: document the metrics and the boundary between smoke E2E timing and large-file qualification.
- `.env.github-e2e.example`: stop advertising benchmark/profile variables that the runner does not consume.

## Design Decision and Tradeoff

Do not always replace Contents reads with Git Blob reads: that would add a second network request to every small config/head/shard/text read. Do not detect `.enc` by filename: that would couple the generic GitHub transport to V4 storage naming and still miss binary files in other modes. Git blob SHA validation keeps the current one-request fast path for correct payloads and adds one fallback request only when the response bytes are demonstrably wrong. The SHA-1 operation is used only for Git object identity; if the runtime cannot perform it, the implementation falls back to the canonical blob endpoint rather than returning unverified bytes.

### Task 1: Add a red regression test for corrupted binary Contents bytes

**Files:**
- Modify: `tests/v4/github-transport.test.ts:1-80,97-125`

**Interfaces:**
- Consumes: the existing `GitHubClient.getFileBytes(path, ref)` contract and `setRequestUrlHandler` test seam.
- Produces: a failing test proving that a valid Git blob SHA must cause the client to reject transformed Contents bytes and obtain the canonical blob.

- [ ] **Step 1: Make the existing text fixture use a real Git blob SHA.**

Change the existing `getFileBytes` fixture payload from `sha: "blob-sha"` to the Git blob SHA for the UTF-8 bytes `transformed`, `a5df5b6112f9310f9b7d922dc562cd9d413ecf02`, and keep the assertion that the request count remains one. This makes the fast-path test meaningful after SHA validation is added.

- [ ] **Step 2: Add the binary transformation helper and failing test.**

Add this test-only helper immediately before the new test:

```ts
function githubContentsUtf16beTransform(bytes: Uint8Array): Uint8Array {
  let text = ""
  for (let index = 0; index + 1 < bytes.byteLength; index += 2) {
    text += String.fromCharCode((bytes[index] << 8) | bytes[index + 1])
  }
  if ((bytes.byteLength & 1) !== 0) text += "\uFFFD"
  return new TextEncoder().encode(text)
}
```

Import `toBase64` from `src/lib/bytes.ts` and add this test:

```ts
test("GitHubClient falls back to the canonical Git Blob when Contents transforms binary bytes", async () => {
  const raw = Uint8Array.from([
    79, 71, 83, 52, 1, 253, 142, 97, 212, 167, 10, 51, 86, 115, 77, 87, 209, 244, 140,
    48, 80, 42, 244, 84, 28, 131, 154, 197, 154, 111, 119, 70, 50, 225, 97, 66, 143,
  ])
  const blobSha = "5a469309d6d8c744bb48764f30ff665c3c2d65ca"
  const requests: string[] = []
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { url: string }
    requests.push(request.url)
    if (request.url.includes("/contents/")) {
      return {
        status: 200,
        text: "",
        headers: {},
        json: { content: toBase64(githubContentsUtf16beTransform(raw)), encoding: "base64", sha: blobSha },
        arrayBuffer: new ArrayBuffer(0),
      }
    }
    return { status: 200, text: "", headers: {}, json: undefined, arrayBuffer: raw.buffer }
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    const file = await client.getFileBytes("binary.enc", "commit-sha")
    assert.deepEqual(file?.bytes, raw)
    assert.equal(file?.sha, blobSha)
    assert.equal(requests.length, 2)
    assert.equal(requests.some(url => url.endsWith(`/git/blobs/${blobSha}`)), true)
  } finally {
    setRequestUrlHandler(null)
  }
})
```

- [ ] **Step 3: Run the focused test to verify the regression is red.**

Run: `npm test -- --filter=tests/v4/github-transport.test.ts`

Expected before the implementation: the new binary test fails because `getFileBytes()` returns the transformed 56-byte Contents payload instead of the 37-byte blob payload. The existing text test must still pass.

### Task 2: Validate Git blob identity and repair binary reads with the minimal fallback

**Files:**
- Modify: `src/lib/github-api.ts:1-4,178-197`
- Test: `tests/v4/github-transport.test.ts`

**Interfaces:**
- Consumes: `getFileBytes()`'s `sha` returned by GitHub Contents and the existing `getBlob(sha)` method.
- Produces: the same `{ bytes, sha }` result shape; valid Contents payloads stay one request, mismatched payloads return canonical Git Blob bytes.

- [ ] **Step 1: Add a Git blob SHA-1 helper inside `GitHubClient`.**

Import `toHex` from `src/lib/bytes.ts` and add this private method near `getFileBytes()`:

```ts
private async gitBlobSha1(bytes: Uint8Array): Promise<string> {
  const header = utf8ToBytes(`blob ${bytes.byteLength}\0`)
  const payload = new Uint8Array(header.byteLength + bytes.byteLength)
  payload.set(header)
  payload.set(bytes, header.byteLength)
  return toHex(await crypto.subtle.digest("SHA-1", payload))
}
```

This is an identity check for Git's object format, not a security/authentication primitive. It uses the same Web Crypto surface already used by V4 hashing.

- [ ] **Step 2: Add the mismatch fallback after base64 decoding.**

Replace the current direct return inside the `encoding === "base64"` branch with this single-fallback flow:

```ts
let decoded: Uint8Array | undefined
try {
  decoded = fromBase64(json.content)
} catch {
  decoded = undefined
}
if (decoded) {
  let verified = true
  if (/^[0-9a-f]{40}$/u.test(sha)) {
    try { verified = await this.gitBlobSha1(decoded) === sha } catch { verified = false }
  }
  if (verified) return { bytes: decoded, sha }
}
if (sha) return { bytes: await this.getBlob(sha), sha }
```

The invalid/non-Git-shaped SHA behavior remains compatible with existing unit fakes. A valid text/metadata payload whose Git SHA matches does not make a second request; the real binary corruption path makes exactly one canonical blob request. Separating decode/hash from the fallback prevents a failed blob request from being issued twice and makes SHA-1 capability failure safe: the client simply uses the canonical blob endpoint.

- [ ] **Step 3: Run the focused transport tests and confirm green.**

Run: `npm test -- --filter=tests/v4/github-transport.test.ts`

Expected: all transport tests pass, including the new binary fallback and the one-request valid-text assertion.

- [ ] **Step 4: Run the existing encrypted object/session tests.**

Run: `npm test -- --filter=tests/v4/sync-session.test.ts`

Expected: 86 tests pass; no fake GitHub session behavior changes.

### Task 3: Remove the rate-limit timing flake without weakening the behavior check

**Files:**
- Modify: `tests/v4/github-transport.test.ts:58-79`
- No production file change is expected.

**Interfaces:**
- Consumes: `V4RequestScheduler`'s existing `now` and `sleep` injection points.
- Produces: a deterministic assertion that a two-second `Retry-After` delay is scheduled exactly once.

- [ ] **Step 1: Replace wall-clock dependence with a fake monotonic clock.**

Change the test setup to:

```ts
let now = 0
const scheduler = new V4RequestScheduler({
  readConcurrency: 2,
  writeConcurrency: 1,
  now: () => now,
  sleep: async milliseconds => {
    sleeps.push(milliseconds)
    now += milliseconds
  },
})
```

Keep `assert.deepEqual(sleeps, [2_000])` and the two-attempt assertion. This removes the real `Date.now()` tick that produced `1_999` in the repeat run while preserving exact delay semantics.

- [ ] **Step 2: Run the focused test repeatedly.**

Run: `npm test -- --filter=tests/v4/github-transport.test.ts`

Expected: 20/20 pass on every run after Task 1 adds the binary regression, with no dependence on the host clock.

### Task 4: Make live E2E timing and transport behavior observable

**Files:**
- Modify: `tests/github-e2e/v4-real-github-e2e.test.ts:178-335`
- Modify: `docs/github-e2e.md:1-30`

**Interfaces:**
- Consumes: `GitHubClient.transportMetricsSnapshot` and the existing per-mode round-trip function.
- Produces: safe JSON metrics for each plaintext/encrypted mode without token, path, body, or raw-byte logging.

- [ ] **Step 1: Measure each mode after branch reset.**

Create `const started = performance.now()` immediately after `const client = new GitHubClient(config)` and wrap the body of `runRoundTrip()` in `try/finally`. In the `finally`, print only:

```ts
console.log(JSON.stringify({
  mode,
  elapsedMs: Number((performance.now() - started).toFixed(1)),
  transport: client.transportMetricsSnapshot,
}))
```

The metric includes request count, mutations, request/response bytes, retries, cooldown/pacing time, unknown outcomes, transient-byte peak, and status classes. It intentionally excludes the raw `fetch()` polling used by `waitForBranchHead()`; document that boundary.

- [ ] **Step 2: Keep the binary Contents-vs-Blob assertion and exercise encrypted history journals.**

Do not remove the assertion at the current object verification block. Import `V4HistoryService`, then after the final `publishedCommitSha` is known, load the published plugin commit through the real client and read its journal:

```ts
const history = new V4HistoryService({ github: client, config: remoteConfig, keyring })
const historyPage = await history.listCommits()
const publishedHistoryCommit = historyPage.items.find(item => item.sha === publishedCommitSha && item.source === "plugin")
assert.ok(publishedHistoryCommit?.journalId)
const historyChanges = await history.getCommitChanges(publishedHistoryCommit)
assert.equal(historyChanges.some(change => change.path === (mode === "encrypted" ? "Notes/hello-renamed.md" : "Notes/hello.md")), true)
```

This keeps the binary object assertion, verifies the encrypted `.enc` journal path through `getFileBytes()`, and lets the test proceed to encrypted Force Pull and final byte/identity assertions.

- [ ] **Step 3: Document the metric output and current workload boundary.**

Update `docs/github-e2e.md` to state that the quick E2E covers small plaintext/encrypted force push, encrypted rename, no-op, binary object validation, force pull, and cleanup. State that its elapsed time is a network smoke measurement, not a 5 GiB qualification, and list the JSON metric fields.

- [ ] **Step 4: Run the real E2E and verify cleanup.**

Run: `npm run test:github-e2e:quick`

Expected: one test passes, both mode metric lines are printed, encrypted Force Pull completes, and `GitHub E2E branch cleanup verified` is printed.

### Task 5: Remove unimplemented benchmark settings from the public example

**Files:**
- Modify: `.env.github-e2e.example:6-12`
- Modify: `docs/github-e2e.md:1-40`

**Interfaces:**
- Consumes: the actual `scripts/run-github-e2e.mjs` environment contract.
- Produces: an example configuration that matches the runner instead of suggesting unsupported benchmark profiles.

- [ ] **Step 1: Remove unused variables from the example.**

Delete the following lines from `.env.github-e2e.example`:

```text
# Suite profile: smoke is fast and skips heavy benchmarks by default.
GITHUB_E2E_PROFILE=quick
GITHUB_E2E_RUN_BENCHMARKS=0

# Optional full benchmark controls.
GITHUB_E2E_PACK_FILES=10050
GITHUB_E2E_LARGE_MIB=51
```

Keep only the four variables that `scripts/run-github-e2e.mjs` actually loads and validates: owner, repo, branch, and token.

- [ ] **Step 2: State the benchmark boundary in the E2E documentation.**

Document that the current runner is a small real-REST smoke suite with safe metrics. Do not describe pack/large-file environment variables until a separate runner implements those workloads and records their request, memory, and final-byte evidence.

### Task 6: Full verification and intentional handoff

**Files:**
- No new source files.
- Review: all files changed by Tasks 1–4 plus pre-existing workspace status.

**Interfaces:**
- Consumes: the corrected GitHub client, deterministic tests, and instrumented live E2E.
- Produces: evidence-backed readiness status; no large-file qualification claim unless a separate benchmark workload is run.

- [ ] **Step 1: Run build and the fast suite.**

Run: `npm run build` and `npm test`

Expected: build exit code 0 and the full fast suite passes with the current test count plus the new binary regression test.

- [ ] **Step 2: Run recovery, resource, feasibility, and virtual crypto checks.**

Run: `npm run test:recovery`, `npm run test:resource`, `npm run test:feasibility`, and `npm run test:soak -- --bytes=67108864`

Expected: recovery/resource/feasibility remain green; the 64 MiB digest matches Node's reference and RSS remains bounded.

- [ ] **Step 3: Run the repeat gate.**

Run: `npm run test:repeat`

Expected: all configured fast repeats pass without the 1,999/2,000 ms timing flake.

- [ ] **Step 4: Check the patch and workspace scope.**

Run: `git diff --check` and `git status --short --branch`

Expected: no whitespace errors; only intended source/test/docs files are staged, and the two pre-existing image deletions remain unstaged.

- [ ] **Step 5: Commit the fix in reviewable units.**

Use these commits after their corresponding verification gates:

```text
fix: validate GitHub Contents bytes against blob identity
test: make rate-limit timing deterministic
test: instrument real GitHub E2E transport metrics
```

Do not push or alter the pre-existing image deletions as part of this plan.

## Scope Boundary for Later Benchmark Work

The current plan makes the smoke E2E correct and measurable. It deliberately does not implement large-file/pack profiles; Task 5 removes the currently misleading example settings. A later benchmark plan can reintroduce explicit profile variables only alongside real pack/large-file workloads and request, memory, and final-byte evidence.

## Self-Review Checklist

- **Spec coverage:** binary Contents corruption, valid-text fast path, encrypted object/history callers, rate-limit timing flake, live E2E speed metrics, stale benchmark configuration, cleanup, and verification commands each have a task.
- **Placeholder scan:** no task depends on an unspecified helper, external fixture, or unbounded “add tests” instruction.
- **Type consistency:** `getFileBytes()` keeps its existing `{ bytes: Uint8Array; sha: string }` return type; `transportMetricsSnapshot` is read-only through the existing getter; no caller signature changes are required.
- **Known gap:** large/pack GitHub workload remains outside this fix plan and will not be reported as passed by these tasks.

**Verdict for this plan:** fix-then-ship. The live E2E has a confirmed encrypted binary correctness failure; the first gate is the canonical Git Blob fallback, followed by a full live round trip.
