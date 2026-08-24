# Release and Real-GitHub E2E Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make package metadata single-source, lock the current conflict semantics with deterministic regressions, add missing namespace/race coverage, run the real GitHub E2E as an isolated credentialed qualification, and make stable release an explicit exact-SHA fail-closed operation.

**Architecture:** Keep the existing V4 sync algorithm unchanged unless a new deterministic regression proves a concrete defect. Separate ordinary secret-free CI from credentialed live qualification; use exact GitHub Actions run/job metadata for release authority, and remove the existing prerelease release-bypass. Every behavior change starts from a red regression, then receives the smallest production fix.

**Tech Stack:** TypeScript, Node.js 22 test runner, esbuild, pnpm 9, GitHub Actions, GitHub CLI (`gh`), Obsidian plugin API.

**Spec:** `docs/superpowers/specs/2026-08-24-release-and-e2e-hardening-design.md`

## Global Constraints

- Preserve current executable Copy policy: local version remains canonical; remote version becomes a conflict copy.
- Do not add a new runtime dependency.
- Do not add random/sleep-based concurrency tests; races must be deterministic.
- Do not claim strict server-side Git ref CAS; preserve pre-read + non-force update + bounded runtime replan.
- No 5 GiB physical qualification, pack-scale benchmark, or new public alpha/beta release channel.
- Real GitHub qualification must use a dedicated disposable repository and a unique `obsidian-sync-e2e/run-${GITHUB_RUN_ID}` branch.
- Stable release must qualify exactly the current `master` SHA and fail closed for stale/missing/skipped qualification.
- Production V4 changes are permitted only after a failing regression demonstrates the need.

## File Map

- `.gitignore` — canonical lockfile/secret ignores.
- `package-lock.json` — remove non-canonical npm lockfile.
- `scripts/update-version.js` — atomic-preflight-style version metadata bump helper.
- `scripts/validate-package.mjs` — offline package/release metadata validator.
- `tests/v4/release-metadata.test.mjs` — isolated temp-repo tests for the two scripts.
- `src/setting.tsx` — make Copy policy direction explicit in Settings.
- `docs/FAQ.md` — align English/Chinese Copy policy docs with executable behavior.
- `tests/v4/conflicts.test.ts` — resolver contract remains local-primary.
- `tests/v4/sync-session.test.ts` — exact conflict outcomes, namespace collision regressions, conflict-copy collision regressions.
- `src/lib/v4/sync-session.ts` — only if namespace/copy-path regressions expose a concrete unsafe mutation path.
- `tests/v4/sync-coordinator.test.ts` — expanded rescan causality matrix.
- `tests/v4/runtime-retry.test.ts` — user-facing automatic publication-race retry proof.
- `tests/github-e2e/v4-real-github-e2e.test.ts` — exact multi-device assertions and encrypted external-mutation refusal.
- `.github/workflows/github-e2e-live.yml` — credentialed exact-SHA qualification + separate cleanup job.
- `.github/workflows/pre-release.yml` — convert to read-only Branch Candidate Build.
- `.github/workflows/release.yml` — explicit qualified stable release.
- `docs/github-e2e.md` — environment/setup/run/cleanup instructions.
- `docs/releasing.md` — maintainer candidate/qualification/release/partial-publication flow.
- `README.md` — qualification-status wording.

---

### Task 1: Package Metadata and Version Tooling

**Files:**
- Modify: `.gitignore`
- Delete: `package-lock.json`
- Modify: `scripts/update-version.js`
- Modify: `scripts/validate-package.mjs`
- Create: `tests/v4/release-metadata.test.mjs`

**Interfaces:**
- Consumes: `package.json.version`, `manifest.json.version`, `manifest.minAppVersion`, `versions.json`, `package.json.packageManager`, Git tracked-file state.
- Produces: `node scripts/update-version.js <patch|minor|major|x.y.z>` that computes one target version and updates package/manifest/versions metadata; `node scripts/validate-package.mjs` that fails offline on metadata/lockfile drift.

- [ ] **Step 1: Write failing metadata-script tests**

Create `tests/v4/release-metadata.test.mjs` using `node:test`, `node:assert/strict`, `mkdtemp`, `spawnSync`, and a helper that initializes a temporary Git repository with minimal `package.json`, `manifest.json`, `versions.json`, `pnpm-lock.yaml`, and release artifact files. Copy the repository scripts under test into the fixture before spawning them.

The tests must assert these exact cases:

```js
await t.test("version helper derives one target and updates all metadata", () => {
  // start package/manifest at 1.2.3, minAppVersion 1.11.4
  // run: node scripts/update-version.js patch
  // expect package.version === "1.2.4"
  // expect manifest.version === "1.2.4"
  // expect versions["1.2.4"] === "1.11.4"
});

await t.test("version helper refuses pre-existing package/manifest drift without mutation", () => {
  // package 1.2.3, manifest 1.2.4
  // snapshot all three JSON strings
  // run patch => non-zero
  // exact file contents remain equal to snapshots
});

await t.test("version helper rejects malformed, non-increasing, duplicate target", () => {
  // reject 1.2, 1.2.3 when current is 1.2.3, and target already present in versions.json
});

await t.test("validator rejects compatibility and lockfile drift", () => {
  // versions mapping mismatch => fail
  // tracked package-lock.json => fail
  // tracked yarn.lock => fail
});

await t.test("validator accepts canonical pnpm metadata after build artifacts exist", () => {
  // valid package/manifest/versions, tracked pnpm-lock, main.js/manifest/styles exist => exit 0
});
```

- [ ] **Step 2: Run the new tests and prove they fail on current scripts**

Run:

```bash
pnpm test:fast -- --filter=release-metadata
```

If the package script does not forward the extra filter syntax, run the underlying runner directly:

```bash
node scripts/run-tests.mjs --tier=fast --filter=release-metadata
```

Expected: FAIL because `update-version.js` does not update `versions.json`, accepts `npm_package_version`, and the validator does not enforce canonical lock/version metadata.

- [ ] **Step 3: Harden `update-version.js` with read/preflight/compute/write**

Refactor the main flow so it:

```js
const packageJson = readJson(packagePath);
const manifest = readJson(manifestPath);
const versions = readJson(versionsPath);

if (!isValidSemver(packageJson.version) || packageJson.version !== manifest.version) {
  throw new Error(`Current version metadata is inconsistent: package=${packageJson.version} manifest=${manifest.version}`);
}

const requested = process.argv.slice(2)[0] ?? process.env.NEW_VERSION;
if (!requested) throw new Error("Provide x.y.z or major/minor/patch explicitly.");

const target = bumpOptions.has(resolve(requested))
  ? bumpVersion(packageJson.version, resolve(requested))
  : resolve(requested);

if (!isValidSemver(target)) throw new Error(`Invalid target version: ${target}`);
if (compareSemver(target, packageJson.version) <= 0) throw new Error(`Target version must be greater than ${packageJson.version}`);
if (Object.hasOwn(versions, target)) throw new Error(`versions.json already contains ${target}`);

const nextPackage = { ...packageJson, version: target };
const nextManifest = { ...manifest, version: target };
const nextVersions = { ...versions, [target]: manifest.minAppVersion };

writeJsonWithBackup(packagePath, nextPackage);
writeJsonWithBackup(manifestPath, nextManifest);
writeJsonWithBackup(versionsPath, nextVersions);
```

Implement a numeric three-component `compareSemver(a, b)`; do not shell out to `sort -V` and do not use a new dependency. Remove `npm_package_version` fallback entirely.

- [ ] **Step 4: Harden `validate-package.mjs`**

Add helpers:

```js
const STABLE_SEMVER = /^\d+\.\d+\.\d+$/u;
function tracked(path) {
  return spawnSync("git", ["ls-files", "--error-unmatch", "--", path], { stdio: "ignore" }).status === 0;
}
```

Read `versions.json`, then enforce:

```js
if (!STABLE_SEMVER.test(packageJson.version) || !STABLE_SEMVER.test(manifest.version)) throw new Error("Release version must be x.y.z");
if (packageJson.version !== manifest.version) throw new Error(...);
if (!STABLE_SEMVER.test(manifest.minAppVersion ?? "")) throw new Error("manifest.minAppVersion must be x.y.z");
if (versions[manifest.version] !== manifest.minAppVersion) throw new Error(...);
if (typeof packageJson.packageManager !== "string" || !packageJson.packageManager.startsWith("pnpm@")) throw new Error("packageManager must declare pnpm");
if (!tracked("pnpm-lock.yaml")) throw new Error("pnpm-lock.yaml must be tracked");
for (const alternate of ["package-lock.json", "yarn.lock"]) if (tracked(alternate)) throw new Error(`Non-canonical lockfile is tracked: ${alternate}`);
```

Preserve existing artifact and local-secret validation.

- [ ] **Step 5: Remove alternate lockfile and clean ignores**

Delete tracked `package-lock.json`. In `.gitignore`, keep one GitHub-E2E secret block and add root-only alternate locks:

```gitignore
/package-lock.json
/yarn.lock
```

- [ ] **Step 6: Run targeted tests**

Run:

```bash
node scripts/run-tests.mjs --tier=fast --filter=release-metadata
```

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

```bash
git add .gitignore scripts/update-version.js scripts/validate-package.mjs tests/v4/release-metadata.test.mjs
git rm package-lock.json
git commit -m "build: harden release metadata tooling"
```

---

### Task 2: Lock the Copy-Policy User Contract and Exact Conflict Outcomes

**Files:**
- Modify: `src/setting.tsx`
- Modify: `docs/FAQ.md`
- Modify: `tests/v4/conflicts.test.ts`
- Modify: `tests/v4/sync-session.test.ts`
- Modify: `tests/github-e2e/v4-real-github-e2e.test.ts`

**Interfaces:**
- Consumes: `resolveV4Conflict({ policy: "copy" }) -> { action: "keep-local-copy-remote" }`, `V4SyncSession.conflictCopyPath()` naming contract.
- Produces: documented/tested invariant: local bytes stay canonical, remote bytes are preserved as one conflict copy with a distinct identity.

- [ ] **Step 1: Strengthen unit expectations for resolver semantics**

In `tests/v4/conflicts.test.ts`, keep the action assertion and add a test name/message that explicitly states local-primary semantics:

```ts
test("v4 copy policy keeps local primary and requests one remote copy", () => {
  assert.equal(resolveV4Conflict({ policy: "copy", path: "a.md", localMtime: 2, remoteMtime: 3 }).action, "keep-local-copy-remote");
});
```

- [ ] **Step 2: Add exact session regressions for same-file, rename/edit, and delete/edit asymmetry**

Using the existing `MemoryGitHub`, `MemoryVault`, `createEmptyV4LocalIndex`, and session fixtures in `tests/v4/sync-session.test.ts`, add deterministic fixed-clock tests for:

```text
same-file edit/edit:
  canonical shared.md == local bytes
  exactly one shared.conflict-remote-<device>-<fixed>.md == remote bytes
  canonical fileId == original fileId
  copy fileId != original

remote rename old->new vs stale local edit old:
  old == stale local bytes with original fileId
  exactly one conflict copy derived from remote new path == remote bytes
  no standalone new path remains
  fresh third index path set is exact

remote delete vs stale local edit:
  local edited canonical survives with original identity
  zero conflict copies

local delete vs remote edit:
  canonical path absent
  exactly one remote conflict copy survives with new identity
```

The red phase is required before modifying production code. If these tests already pass, production sync behavior remains unchanged.

- [ ] **Step 3: Tighten live rename-vs-edit assertions**

Replace the current byte-anywhere assertions in `runRenameVsEditScenario` with exact path/identity assertions matching the session contract. Use fixed `now()` for Device B so the expected conflict-copy path is deterministic. For a fresh Device C, assert exact live path set and bytes instead of only `assertVaultContainsBytes`.

For encrypted mode, additionally assert original canonical fileId stability and distinct conflict-copy fileId; call the existing encrypted transport verification for both records.

- [ ] **Step 4: Align Settings and FAQ wording**

Change Settings option:

```ts
.addOption("copy", "Copy (keep local, preserve remote copy)")
```

and set the description to explicitly say that when both sides changed, the local file keeps its normal path and the remote version is preserved under a conflict-copy filename.

Update English and Chinese FAQ Copy policy text to the same contract. Do not change `resolveV4Conflict` behavior.

- [ ] **Step 5: Run targeted conflict tests and E2E compile**

Run:

```bash
node scripts/run-tests.mjs --tier=fast --filter=conflicts
node scripts/run-tests.mjs --tier=fast --filter=sync-session
GITHUB_E2E_COMPILE_ONLY=1 pnpm test:github-e2e:quick
```

Expected: PASS after test/assertion/doc alignment. If a newly exact session regression fails, stop and use TDD to fix only the demonstrated behavior before continuing.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/setting.tsx docs/FAQ.md tests/v4/conflicts.test.ts tests/v4/sync-session.test.ts tests/github-e2e/v4-real-github-e2e.test.ts
git commit -m "test: define exact V4 copy conflict contract"
```

---

### Task 3: Cross-Side Namespace Safety and Conflict-Copy Collision

**Files:**
- Modify: `tests/v4/sync-session.test.ts`
- Modify only if red regression requires it: `src/lib/v4/sync-session.ts`

**Interfaces:**
- Consumes: local/remote `V4LogicalFile` records and existing case-insensitive collision convention.
- Produces if needed: a pre-plan combined namespace assertion that rejects two different fileIds mapping to the same `NFC + lowercase` key before pull/push mutation.

- [ ] **Step 1: Write red combined-namespace regressions**

Add tests where local and remote are each individually valid but combined state contains different identities at:

```text
same exact path:       note.md / note.md
case collision:        Foo.md / foo.md
normalization collision: é.md / e\u0301.md
```

Instrument `MemoryVault.operations` and `MemoryGitHub` mutation counters. Expected error must match a clear collision diagnostic, and assertions must prove no local write/trash and no new publication commit happened after the collision was known.

Add a control case where the **same fileId** changes only case (`Foo.md -> foo.md`) and remains a legal rename.

- [ ] **Step 2: Run the namespace tests and inspect the real failure point**

Run:

```bash
node scripts/run-tests.mjs --tier=fast --filter=sync-session
```

Expected initial result: at least one cross-side collision regression should fail or fail too late if current separate local/remote validation is insufficient.

- [ ] **Step 3: If red, implement the smallest combined namespace guard**

Add a focused helper near the existing collision assertion in `sync-session.ts`, conceptually:

```ts
function normalizedNamespaceKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function assertCombinedNamespaceSafe(local: V4LogicalFile[], remote: V4LogicalFile[]): void {
  const seen = new Map<string, { fileId: string; path: string }>();
  for (const file of [...remote, ...local]) {
    const key = normalizedNamespaceKey(file.path);
    const prior = seen.get(key);
    if (!prior) { seen.set(key, { fileId: file.fileId, path: file.path }); continue; }
    if (prior.fileId !== file.fileId) {
      throw new Error(`V4 path collision across local/remote state: ${prior.path} vs ${file.path}`);
    }
  }
}
```

Invoke it after local scan/remote load but **before** planning or any pull/push application. Reuse the existing normalization convention exactly; if the current helper already exists elsewhere, call/refactor it instead of duplicating logic.

- [ ] **Step 4: Write conflict-copy occupied-path regression**

Create a conflict whose deterministic copy path is already occupied by an unrelated fileId. Assert the sync refuses before overwriting that user file. A clear error is sufficient; do not add numbered fallback naming in this hardening.

- [ ] **Step 5: Run targeted tests**

```bash
node scripts/run-tests.mjs --tier=fast --filter=sync-session
```

Expected: PASS, with no silent overwrite and same-identity case rename still allowed.

- [ ] **Step 6: Commit Task 3**

If production changed:

```bash
git add tests/v4/sync-session.test.ts src/lib/v4/sync-session.ts
git commit -m "fix: reject ambiguous cross-device V4 paths"
```

If all regressions passed without production change:

```bash
git add tests/v4/sync-session.test.ts
git commit -m "test: cover cross-device namespace collisions"
```

---

### Task 4: Rescan Causality Matrix and Runtime Automatic Replan

**Files:**
- Modify: `tests/v4/sync-coordinator.test.ts`
- Create: `tests/v4/runtime-retry.test.ts`
- Modify only if regressions require it: `src/lib/v4/sync-coordinator.ts`, `src/lib/v4/runtime.ts`

**Interfaces:**
- Consumes: `coalesceV4Changes(changes)`, `V4PluginRuntime.manualSync()`, runtime progress snapshot `attempt`.
- Produces: deterministic proof that rescans preserve identity-breaking events and user-facing runtime retries recoverable publication races without a second manual action.

- [ ] **Step 1: Add a table-driven rescan causality matrix**

In `tests/v4/sync-coordinator.test.ts`, add explicit cases for:

```ts
const cases = [
  { name: "replace + rescan", changes: [replace("a", "a"), rescan()], mustKeep: "replace" },
  { name: "rename + rescan", changes: [rename("a", "b"), rescan()], mustKeep: "rename" },
  { name: "delete + rescan", changes: [del("a"), rescan()], mustKeep: "delete" },
  { name: "folder rename + rescan", changes: [folderRename("A", "B"), rescan()], mustKeep: "folderRename" },
  { name: "folder delete + rescan", changes: [folderDelete("A"), rescan()], mustKeep: "folderDelete" },
  { name: "delete recreate + rescan", changes: [del("a"), modify("a"), rescan()], mustKeep: "replace" },
];
```

Keep existing optimization coverage proving content-only modifies may collapse to one rescan.

- [ ] **Step 2: Run coordinator regression matrix before production edits**

```bash
node scripts/run-tests.mjs --tier=fast --filter=sync-coordinator
```

Expected: existing fixed causality cases pass; any newly exposed ambiguous chain must be red before changing `sync-coordinator.ts`.

- [ ] **Step 3: Create a runtime-level race test fixture**

Create `tests/v4/runtime-retry.test.ts`. Stub a minimal `FastSync`-shaped plugin and GitHub client so the first publication attempt throws a recoverable stale-ref/branch-head-changed error after advancing the fake remote head; the second attempt succeeds from the advanced head.

The test must invoke only one user action:

```ts
const result = await runtime.manualSync();
assert.ok(result);
assert.equal(publishAttempts, 2);
assert.equal(runtime.progressSnapshot.lifecycle, "success");
assert.equal(maxObservedAttempt, 2);
assert.equal(userManualActions, 1);
assert.equal(conflictCopiesCreated, 0);
```

Use the real `V4PluginRuntime`; do not test a reimplemented retry loop.

- [ ] **Step 4: Run runtime test and fix only if behavior is not already covered**

```bash
node scripts/run-tests.mjs --tier=fast --filter=runtime-retry
```

Expected: PASS if existing bounded retry semantics are correctly reachable through the fixture. If red because runtime does not retry the production error class/message, keep the red regression and apply the smallest change to `runtime.ts`.

- [ ] **Step 5: Commit Task 4**

```bash
git add tests/v4/sync-coordinator.test.ts tests/v4/runtime-retry.test.ts
git add src/lib/v4/sync-coordinator.ts src/lib/v4/runtime.ts 2>/dev/null || true
git commit -m "test: harden V4 causality and runtime replan coverage"
```

---

### Task 5: Harden the Real GitHub E2E Harness

**Files:**
- Modify: `tests/github-e2e/v4-real-github-e2e.test.ts`
- Modify if helper behavior is needed: `scripts/run-github-e2e.mjs`
- Modify: `docs/github-e2e.md`

**Interfaces:**
- Consumes: existing `GITHUB_E2E_OWNER`, `GITHUB_E2E_REPO`, `GITHUB_E2E_BRANCH`, `GITHUB_E2E_TOKEN`; disposable branch only.
- Produces: deterministic live suite with exact conflict assertions and encrypted external-mutation refusal.

- [ ] **Step 1: Add encrypted external-mutation safety scenario**

Add a live scenario that:

1. initializes encrypted V4 and publishes normally,
2. creates an out-of-band Git commit on the same branch without updating the encrypted V4 journal/head contract,
3. advances the branch with `force: false`,
4. attempts normal plugin sync,
5. asserts a clear encrypted external-change refusal,
6. asserts the injected commit remains reachable and branch head is not silently overwritten by the plugin.

Use deterministic mutation timing and existing request bridge/client helpers; do not add sleeps.

- [ ] **Step 2: Preserve the source-repo and protected-branch safety checks**

Keep runner-level forbidden branch names. The workflow will add a stronger repository-isolation guard, but local manual runs must still refuse `main`, `master`, `production`, `prod`, `release`, and `stable`.

- [ ] **Step 3: Compile the harness**

```bash
GITHUB_E2E_COMPILE_ONLY=1 pnpm test:github-e2e:quick
```

Expected: PASS.

- [ ] **Step 4: Update E2E docs for the new scenario and dynamic workflow branch**

Document that local/manual `.env.github-e2e` can still specify a disposable branch, while GitHub Actions derives one per run. State that the suite is not 5 GiB qualification.

- [ ] **Step 5: Commit Task 5**

```bash
git add tests/github-e2e/v4-real-github-e2e.test.ts scripts/run-github-e2e.mjs docs/github-e2e.md
git commit -m "test: harden live GitHub E2E safety coverage"
```

---

### Task 6: Add Credentialed Live Qualification Workflow

**Files:**
- Create: `.github/workflows/github-e2e-live.yml`
- Modify: `docs/github-e2e.md`

**Interfaces:**
- Consumes GitHub Environment `github-e2e`: variables `E2E_OWNER`, `E2E_REPO`; secret `E2E_TOKEN`.
- Produces workflow/job authority: exact `master` `github.sha`, job ids `qualify` and `cleanup`, both successful; best-effort audit artifact.

- [ ] **Step 1: Create workflow with exact trigger, permissions, and environment mapping**

Use this structural contract:

```yaml
name: GitHub E2E Live
on:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: github-e2e-live
  cancel-in-progress: false

jobs:
  qualify:
    name: qualify
    runs-on: ubuntu-latest
    timeout-minutes: 25
    environment: github-e2e
    env:
      GITHUB_E2E_OWNER: ${{ vars.E2E_OWNER }}
      GITHUB_E2E_REPO: ${{ vars.E2E_REPO }}
      GITHUB_E2E_TOKEN: ${{ secrets.E2E_TOKEN }}
      GITHUB_E2E_BRANCH: obsidian-sync-e2e/run-${{ github.run_id }}
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.sha }}
      # setup pnpm/node
      # guard master/current SHA/source repo isolation
      # pnpm install --frozen-lockfile
      # pnpm build
      # pnpm test:github-e2e:quick
      # write audit JSON
      # upload-artifact continue-on-error: true

  cleanup:
    name: cleanup
    if: always()
    needs: qualify
    runs-on: ubuntu-latest
    timeout-minutes: 5
    environment: github-e2e
    env:
      E2E_OWNER: ${{ vars.E2E_OWNER }}
      E2E_REPO: ${{ vars.E2E_REPO }}
      E2E_TOKEN: ${{ secrets.E2E_TOKEN }}
      E2E_BRANCH: obsidian-sync-e2e/run-${{ github.run_id }}
    steps:
      - name: Delete disposable branch
        env:
          GH_TOKEN: ${{ env.E2E_TOKEN }}
        run: |
          for attempt in 1 2 3; do
            code=$(curl -sS -o /tmp/delete.out -w "%{http_code}" \
              -X DELETE \
              -H "Authorization: Bearer $GH_TOKEN" \
              -H "Accept: application/vnd.github+json" \
              "https://api.github.com/repos/$E2E_OWNER/$E2E_REPO/git/refs/heads/${E2E_BRANCH//\//%2F}") || code=000
            if [ "$code" = 204 ] || [ "$code" = 422 ] || [ "$code" = 404 ]; then exit 0; fi
            sleep $((attempt * 2))
          done
          exit 1
```

Do not use `GITHUB_*` names for GitHub configuration variables/secrets; they are process env only.

- [ ] **Step 2: Implement fail-closed guard before destructive work**

The `qualify` guard must verify all of:

```bash
test "$GITHUB_REF" = "refs/heads/master"
test "$GITHUB_E2E_OWNER/$GITHUB_E2E_REPO" != "$GITHUB_REPOSITORY"
current_master=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/master" --jq .object.sha)
test "$current_master" = "$GITHUB_SHA"
```

Use the repository `GITHUB_TOKEN` only to read the source repo; use `E2E_TOKEN` only for the disposable target repo.

- [ ] **Step 3: Generate best-effort audit evidence after live success**

Write JSON with `schemaVersion`, `commitSha`, `workflowRunId`, `runAttempt`, `qualifiedAt`, and suite. Upload with artifact name `github-e2e-qualification-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}` and `continue-on-error: true`.

- [ ] **Step 4: Document exact Environment setup and maintainer cleanup command**

In `docs/github-e2e.md`, include:

```text
Environment: github-e2e
Variables: E2E_OWNER, E2E_REPO
Secret: E2E_TOKEN
```

and a copy-paste branch cleanup command parameterized by run id.

- [ ] **Step 5: Commit Task 6**

```bash
git add .github/workflows/github-e2e-live.yml docs/github-e2e.md
git commit -m "ci: add exact-SHA live GitHub qualification"
```

---

### Task 7: Remove the Prerelease Bypass

**Files:**
- Replace: `.github/workflows/pre-release.yml`

**Interfaces:**
- Consumes: non-master manifest-version candidate pushes or manual dispatch.
- Produces: tested plugin artifact only; never writes tags/releases.

- [ ] **Step 1: Replace release-capable workflow with Branch Candidate Build**

Keep the workflow filename for continuity, but set:

```yaml
name: Branch Candidate Build
on:
  push:
    branches-ignore: [master]
    paths: [manifest.json]
  workflow_dispatch:

permissions:
  contents: read
```

The single verify job must run checkout, pnpm/node setup, frozen install, build, `pnpm test`, repeat, recovery, resource, feasibility, E2E compile-only, package validation, then upload `main.js`, `manifest.json`, `styles.css` as an artifact named only with a safe SHA component, e.g. `candidate-${{ github.sha }}`.

Delete all version-comparison, translation, `softprops/action-gh-release`, tag, release, and `contents: write` logic.

- [ ] **Step 2: Review workflow for write-capable steps**

Search the resulting file for these strings and require no matches:

```text
contents: write
action-gh-release
tag_name
deep-translator
GITHUB_TOKEN
```

- [ ] **Step 3: Commit Task 7**

```bash
git add .github/workflows/pre-release.yml
git commit -m "ci: make prerelease workflow artifact-only"
```

---

### Task 8: Replace Stable Release with Explicit Exact-SHA Qualified Release

**Files:**
- Replace: `.github/workflows/release.yml`
- Create: `docs/releasing.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: workflow input `version`, current `master` SHA, existing stable tags/releases, exact-SHA successful `GitHub E2E Live` run with successful `qualify` and `cleanup` jobs.
- Produces: stable tag and GitHub Release at the exact qualified SHA, only after deterministic gates pass.

- [ ] **Step 1: Replace triggers and permissions**

Use:

```yaml
name: Stable Release
on:
  workflow_dispatch:
    inputs:
      version:
        description: Stable version to release (x.y.z)
        required: true
        type: string

permissions:
  actions: read
  contents: write

concurrency:
  group: stable-release
  cancel-in-progress: false
```

The workflow must fail in a normal step if `github.ref != refs/heads/master`; do not hide this with a job-level `if` that could mark the job skipped/successful.

- [ ] **Step 2: Add metadata, monotonic-version, duplicate, and stale-master preflight**

Before build/publication:

```bash
VERSION='${{ inputs.version }}'
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
test "$(jq -r .version manifest.json)" = "$VERSION"
test "$(jq -r .version package.json)" = "$VERSION"
# versions mapping equals manifest.minAppVersion
# current master SHA equals GITHUB_SHA
# refs/tags/$VERSION must not exist
# release by tag $VERSION must not exist
# VERSION must be greater than highest existing stable x.y.z tag
```

Use a small Node snippet for semantic version comparison rather than lexical comparison.

- [ ] **Step 3: Add exact-SHA qualification lookup**

Use `gh api` with repository `GITHUB_TOKEN` to list `github-e2e-live.yml` runs filtered by `head_sha=$GITHUB_SHA`, `event=workflow_dispatch`, status completed. For each success candidate, fetch jobs and accept only a run where both stable job names `qualify` and `cleanup` conclude `success`.

Pseudocode shell:

```bash
run_ids=$(gh api --paginate \
  "repos/$GITHUB_REPOSITORY/actions/workflows/github-e2e-live.yml/runs?head_sha=$GITHUB_SHA&event=workflow_dispatch&status=completed&per_page=100" \
  --jq '.workflow_runs[] | select(.conclusion == "success" and .head_branch == "master" and .head_sha == env.GITHUB_SHA) | .id')

qualified=false
for run_id in $run_ids; do
  jobs=$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$run_id/jobs?per_page=100")
  q=$(jq -r '[.jobs[] | select(.name == "qualify" and .conclusion == "success")] | length' <<<"$jobs")
  c=$(jq -r '[.jobs[] | select(.name == "cleanup" and .conclusion == "success")] | length' <<<"$jobs")
  if [ "$q" -ge 1 ] && [ "$c" -ge 1 ]; then qualified=true; break; fi
done
$qualified
```

No parent/child SHA or latest-success fallback.

- [ ] **Step 4: Run every deterministic gate before publication**

In order:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:repeat
pnpm test:recovery
pnpm test:resource
pnpm test:feasibility
GITHUB_E2E_COMPILE_ONLY=1 pnpm test:github-e2e:quick
pnpm validate:package
```

Then perform the **final** current-master SHA check again.

- [ ] **Step 5: Package and publish with GitHub CLI only after all gates**

Create the plugin ZIP, then:

```bash
gh release create "$VERSION" \
  --repo "$GITHUB_REPOSITORY" \
  --target "$GITHUB_SHA" \
  --title "$VERSION" \
  --generate-notes \
  "$ZIP_PATH" main.js manifest.json styles.css
```

Do not run `deep-translator`, do not use `softprops/action-gh-release`, and do not mutate a tag before the gates. If publication partially fails, leave the workflow failed; do not auto-delete a possibly-valid tag/release.

- [ ] **Step 6: Write maintainer release documentation**

Create `docs/releasing.md` covering:

1. version bump via `pnpm ver -- patch|minor|major|x.y.z`,
2. merge and wait for deterministic CI,
3. configure/dispatch `GitHub E2E Live` on `master`,
4. require `qualify` + `cleanup` success for the exact SHA,
5. dispatch `Stable Release` on `master` with version,
6. inspect a failed partial publication with `gh release view <version>` and `git ls-remote --tags origin refs/tags/<version>`,
7. manually delete only after inspection if the maintainer decides the partial publication is invalid.

- [ ] **Step 7: Update README qualification wording**

State three evidence layers separately: deterministic CI, live real-GitHub qualification, and physical-device/large-file evidence. Do not claim a live pass until an actual live workflow succeeds for a SHA.

- [ ] **Step 8: Commit Task 8**

```bash
git add .github/workflows/release.yml docs/releasing.md README.md
git commit -m "ci: require exact-SHA qualification for stable release"
```

---

### Task 9: Full Verification, Review, and Delivery

**Files:**
- Review all files changed since `43ac573e1feabe39ab0a1a090d7553a2948007fc`.

**Interfaces:**
- Consumes: all Task 1-8 outputs.
- Produces: branch ready for PR/merge; live workflow remains an explicit maintainer-run qualification if credentials are unavailable.

- [ ] **Step 1: Attempt full deterministic verification locally**

Run exactly:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
corepack pnpm test:repeat
corepack pnpm test:recovery
corepack pnpm test:resource
corepack pnpm test:feasibility
GITHUB_E2E_COMPILE_ONLY=1 corepack pnpm test:github-e2e:quick
corepack pnpm validate:package
```

Record real outputs. If dependency/network access prevents execution, do not claim pass; retain the ready-to-run commands for the maintainer.

- [ ] **Step 2: Static workflow safety review**

Verify:

```text
pre-release.yml: contents read only, no tag/release action
ci.yml: no E2E secrets, compile-only only
live E2E: workflow_dispatch only; dedicated target-repo guard; dynamic branch; qualify+cleanup jobs
release.yml: workflow_dispatch only; actions read + contents write; exact SHA qualification; no translation; publication last
```

- [ ] **Step 3: Review branch diff against approved spec**

Run/inspect:

```bash
git diff --check master...HEAD
git diff --stat master...HEAD
git log --oneline master..HEAD
```

Confirm no production V4 modification lacks an associated red regression commit.

- [ ] **Step 4: Request code review / inspect PR diff**

Open a PR from `audit-hardening-2026-08-24` to `master`, review changed-file patches for correctness and spec coverage, and address any concrete findings before merge.

- [ ] **Step 5: Merge only deterministic-ready source**

Merge after deterministic checks available to the environment are green. Do **not** create a stable release automatically.

- [ ] **Step 6: Maintainer live handoff**

Provide these remaining user-run actions if live credentials are unavailable here:

```text
1. Create/use a dedicated disposable E2E repository.
2. GitHub repo Settings → Environments → github-e2e.
3. Add variables E2E_OWNER, E2E_REPO and secret E2E_TOKEN.
4. Actions → GitHub E2E Live → Run workflow on master.
5. Confirm qualify and cleanup both succeeded.
6. Only if a stable release is desired: Actions → Stable Release → Run workflow on master with version 1.0.8 (or the current metadata version).
```

The source hardening can be delivered without step 6; the repository must not be described as live-qualified until step 4-5 actually pass for the target SHA.
