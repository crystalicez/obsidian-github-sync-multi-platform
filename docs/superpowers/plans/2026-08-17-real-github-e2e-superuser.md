# Real GitHub E2E Superuser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the destructive real-GitHub V4 E2E into a deterministic two-logical-device superuser release gate, then align release metadata to version 1.0.8.

**Architecture:** Keep one process and one disposable real GitHub branch, but construct independent Device A/B/C vaults, local indexes, clients, and sessions. Add deterministic sequential multi-device scenarios plus one controlled one-shot branch-head interference hook in the request bridge; preserve existing baseline, encrypted object verification, safe metrics, and cleanup.

**Tech Stack:** TypeScript, Node `node:test`, Obsidian requestUrl test stub, GitHub REST Git Data/Contents APIs, existing V4 sync/session/history code, pnpm, GitHub Actions.

## Global Constraints

- Do not add runtime dependencies.
- Do not use random concurrency or arbitrary sleeps as correctness assertions.
- Never run destructive E2E against `main`, `master`, `production`, `prod`, `release`, or `stable`.
- Do not log GitHub tokens, passphrases, logical file contents, or raw encrypted bytes.
- Do not add 5 GiB, 50+ MiB, or pack-scale workloads to this quick E2E.
- Controlled interference may mutate only the configured disposable branch and must never use a force ref update.
- Preserve final branch cleanup verification.
- Production sync semantics should not change unless the enhanced E2E exposes a concrete defect that requires a separately tested fix.
- Release metadata target is exactly `1.0.8`; do not create a retroactive `1.0.7` tag.

---

### Task 1: Refactor the real-GitHub harness into logical-device helpers

**Files:**
- Modify: `tests/github-e2e/v4-real-github-e2e.test.ts`

**Interfaces:**
- Consumes: existing `MemoryVault`, `GitHubClient`, `V4SyncSession`, `createEmptyV4LocalIndex`, `V4RemoteConfig`, keyring.
- Produces: `DeviceContext`, `createDevice`, deterministic byte fixtures, scenario metrics, and reusable remote verification helpers used by later tasks.

- [ ] **Step 1: Introduce deterministic fixture helpers.**

Add helpers equivalent to:

```ts
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

function deterministicBinary(length: number, seed: number): Uint8Array {
  const output = new Uint8Array(length);
  let value = seed >>> 0;
  for (let index = 0; index < output.length; index++) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    output[index] = value >>> 24;
  }
  return output;
}
```

Use a 1 MiB fixture for the medium binary case.

- [ ] **Step 2: Add a logical device type and constructor.**

Create a helper shape equivalent to:

```ts
interface DeviceContext {
  name: string;
  vault: MemoryVault;
  index: V4LocalIndex;
  client: GitHubClient;
  session: V4SyncSession;
}
```

`createDevice(name, config, remoteConfig, keyring, options?)` must allocate a new vault/index/client/session and set `deviceId` to the supplied logical device name. It must not share an index or vault with another device.

- [ ] **Step 3: Add scenario metric wrapper.**

Wrap each scenario with `performance.now()` and print one safe JSON line containing `scenario`, `mode`, `elapsedMs`, and the involved clients' `transportMetricsSnapshot`. No file contents or secrets.

- [ ] **Step 4: Preserve and migrate the existing single-device assertions.**

Move current force-push, no-op, history, encrypted object-vs-blob, force-pull, identity, and cleanup checks into helper-based code without weakening assertions.

- [ ] **Step 5: Extend baseline fixtures.**

Add these paths to the baseline vault and verify exact round-trip bytes:

```text
Notes/สวัสดี 🌏/mañana.md
Projects/2026 Q3/[draft] #1.md
.workspace/user-state.json
Empty/zero-byte.bin
Assets/medium-1m.bin
```

- [ ] **Step 6: Compile the real E2E bundle.**

Run: `GITHUB_E2E_COMPILE_ONLY=1 pnpm test:github-e2e:quick`

Expected: exit 0 and `GitHub E2E bundle compiled`.

### Task 2: Add deterministic two-device stale/conflict/identity scenarios

**Files:**
- Modify: `tests/github-e2e/v4-real-github-e2e.test.ts`

**Interfaces:**
- Consumes: `createDevice`, baseline remote config/keyring helpers from Task 1.
- Produces: sequential two-device real-remote scenarios that fail loudly on lost updates or identity reuse.

- [ ] **Step 1: Add stale catch-up scenario.**

For each storage mode:

1. Reset branch.
2. Device A force-pushes `shared.md`, `A-only.md`, and a binary file.
3. Device B force-pulls.
4. A modifies `A-only.md` and creates `nested/new-from-a.md`, then normal-syncs.
5. B normal-syncs without editing those paths.
6. Assert B has A's exact new bytes, still has `shared.md`, and has no path containing `.conflict-remote-`.

- [ ] **Step 2: Add same-file copy-conflict preservation.**

Use a fixed `now()` value for Device B so the expected conflict-copy suffix is deterministic. Sequence:

1. A force-pushes `shared.md` with base bytes.
2. B force-pulls.
3. A changes `shared.md` to `from-a` and normal-syncs.
4. B changes its stale `shared.md` to `from-b` and normal-syncs with conflict policy `copy`.
5. Assert canonical `shared.md` contains B's bytes.
6. Assert exactly one local/remote path matches `shared.conflict-remote-device-b-<fixed>.md` and contains A's bytes.
7. Fresh Device C force-pulls and reproduces both files exactly.

- [ ] **Step 3: Add rename-versus-stale-edit scenario.**

Sequence:

1. A force-pushes `Notes/rename-me.md`; B force-pulls.
2. Record A's file identity.
3. A renames to `Notes/renamed.md` using an explicit rename causal change and normal-syncs.
4. B edits stale `Notes/rename-me.md` and normal-syncs.
5. Fresh C force-pulls.
6. Assert every user byte sequence from both lineages remains represented in C and remote state is readable.
7. In encrypted mode, assert A's renamed lineage retains the pre-rename `fileId` and `remotePath`.

- [ ] **Step 4: Add delete-then-recreate identity break.**

Sequence:

1. A force-pushes `Notes/reborn.md`; B force-pulls and records old identity.
2. A deletes the path with explicit delete causality and syncs.
3. A recreates same path with new bytes and explicit create/modify causality and syncs.
4. Assert A's new record has a different `fileId` from the old record.
5. B normal-syncs and assert its final record matches the new generation, not the old identity.

- [ ] **Step 5: Add cross-device binary overwrite verification.**

Sequence:

1. A force-pushes `Assets/shared.bin` with deterministic revision 1.
2. B force-pulls, replaces bytes with deterministic revision 2, and normal-syncs.
3. A normal-syncs and must receive revision 2 exactly.
4. In encrypted mode, verify the record's path-based bytes equal `getBlob(treeNode.sha)` exactly.

- [ ] **Step 6: Compile the expanded E2E bundle.**

Run: `GITHUB_E2E_COMPILE_ONLY=1 pnpm test:github-e2e:quick`

Expected: exit 0.

### Task 3: Add a controlled real branch-head race

**Files:**
- Modify: `tests/github-e2e/v4-real-github-e2e.test.ts`

**Interfaces:**
- Consumes: global request bridge, raw `githubRequest`, configured disposable branch.
- Produces: one-shot deterministic external commit injection immediately before a targeted plugin branch ref update.

- [ ] **Step 1: Add one-shot interference controller state.**

Create harness-only state containing `armed`, `fired`, optional label, and a callback. Keep it disabled by default and reset it after each scenario.

- [ ] **Step 2: Add raw external commit helper.**

Implement `publishExternalCommit(config, marker)` using real REST calls:

1. GET current branch ref.
2. GET current commit to obtain tree SHA.
3. POST `/git/blobs` with a small UTF-8 marker encoded as base64.
4. POST `/git/trees` based on current tree adding `.e2e-external/<marker>.txt`.
5. POST `/git/commits` with the current head as parent and message `external-e2e:<marker>`.
6. PATCH `/git/refs/heads/<branch>` with `{ sha: commitSha, force: false }`.
7. Return the external commit SHA.

Every response must assert the documented success status and include HTTP status in failures without echoing auth headers.

- [ ] **Step 3: Fire interference immediately before one plugin PATCH ref request.**

In `installRequestUrlBridge`, detect the configured branch ref PATCH request while the controller is armed. Before forwarding that one request, call `publishExternalCommit`; mark the hook fired; then forward the original plugin request.

Guard against recursive triggering by marking `fired` before the injected helper performs its own PATCH.

- [ ] **Step 4: Add controlled-race scenario.**

1. A creates a base V4 remote.
2. A edits a file locally.
3. Arm the hook and invoke A normal sync.
4. Assert the hook fired and capture the external commit SHA.
5. Assert the sync rejects with an explicit branch-head-change/replan error rather than reporting success.
6. Verify the external SHA is reachable in branch history.
7. Rerun A sync normally from the observed head.
8. Fresh C force-pulls and verifies both the external marker commit remains in ancestry and A's intended V4 bytes are present.

If the current production behavior returns a specific established branch-head error string, assert that exact stable substring rather than accepting arbitrary failure.

- [ ] **Step 5: Compile the race-enabled bundle.**

Run: `GITHUB_E2E_COMPILE_ONLY=1 pnpm test:github-e2e:quick`

Expected: exit 0.

### Task 4: Update E2E documentation for the stronger release gate

**Files:**
- Modify: `docs/github-e2e.md`

**Interfaces:**
- Consumes: scenario matrix and safe metric output.
- Produces: accurate operator documentation and scope boundary.

- [ ] **Step 1: Document two-device simulation.**

State that one process creates multiple independent logical device states while all devices use the same real GitHub branch, so remote races/conflicts are real even on one physical machine.

- [ ] **Step 2: Document scenario coverage.**

List baseline path edge cases, stale catch-up, copy conflict, rename-vs-edit, delete/recreate identity, binary overwrite, controlled non-force external branch commit, and cleanup.

- [ ] **Step 3: Preserve qualification boundary.**

State explicitly that this still is not physical-device or 5 GiB qualification and does not replace `tests/baselines/v4/windows.json` physical evidence.

### Task 5: Align release metadata to 1.0.8

**Files:**
- Modify: `package.json`
- Modify: `manifest.json`
- Modify: `versions.json`

**Interfaces:**
- Produces: package/release metadata that consistently identifies the next release as 1.0.8 with minimum Obsidian version 1.11.4.

- [ ] **Step 1: Change package version.**

Set:

```json
"version": "1.0.8"
```

in `package.json`.

- [ ] **Step 2: Change manifest version.**

Set:

```json
"version": "1.0.8"
```

in `manifest.json`.

- [ ] **Step 3: Extend versions mapping.**

Add:

```json
"1.0.8": "1.11.4"
```

while retaining existing mappings.

- [ ] **Step 4: Validate package metadata.**

Run: `pnpm validate:package`

Expected: exit 0.

### Task 6: Full verification, review, and publish

**Files:**
- Review all files changed by Tasks 1-5.

**Interfaces:**
- Produces: a reviewed GitHub branch, green CI evidence, merged `master`, and release-triggering 1.0.8 metadata.

- [ ] **Step 1: Run local verification where available.**

Run:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:repeat
pnpm test:recovery
pnpm test:resource
pnpm test:feasibility
pnpm validate:package
GITHUB_E2E_COMPILE_ONLY=1 pnpm test:github-e2e:quick
```

If the execution environment cannot reach GitHub/npm, use GitHub Actions for the repository test gate and report that local limitation explicitly.

- [ ] **Step 2: Run configured real GitHub E2E when credentials are available to the runner.**

Run:

```bash
pnpm test:github-e2e:quick
```

Expected: all scenario groups pass, safe metrics are printed, and final branch cleanup is verified.

If repository CI does not expose destructive E2E credentials by design, compile-only remains automated and the live run is a separate release qualification; do not fabricate a live pass.

- [ ] **Step 3: Open a PR from `test/real-github-e2e-superuser` to `master`.**

PR body must summarize scenario coverage, 1.0.8 metadata alignment, local-vs-Actions verification, and whether a live credentialed E2E was actually run.

- [ ] **Step 4: Wait for branch/PR CI and inspect failures if any.**

Required existing CI gates: build, fast tests, repeat, recovery, resource, feasibility, package validation, artifact upload.

- [ ] **Step 5: Merge only when required CI is green.**

Use a normal merge or squash according to repository convention. Never force-update `master`.

- [ ] **Step 6: Verify post-merge master.**

Confirm `master` contains the merged tree, post-merge CI is green, and release workflow behavior for the manifest version bump is observable. Report the merge commit and any release/tag result separately; do not claim a GitHub Release exists until the workflow actually creates it.

## Self-Review

- Spec coverage: all approved sequential two-device cases and controlled race are mapped to explicit tasks; release 1.0.8 is included.
- Placeholder scan: no TBD/TODO steps or unspecified helpers remain.
- Type consistency: helper names and Device A/B/C state are consistent across tasks; no production API signature change is planned.
- Scope boundary: no 5 GiB, pack-scale, physical-device, random fuzzing, or unrelated refactor work is included.