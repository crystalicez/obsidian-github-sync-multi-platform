# Release and Real-GitHub E2E Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make release metadata single-source, define and prove the current conflict contract, harden cross-device edge cases, execute real GitHub E2E qualification safely, and make stable release explicit and exact-SHA qualified.

**Architecture:** Keep V4 production semantics unchanged unless a deterministic red regression demonstrates a concrete defect. Ordinary CI remains secret-free; live GitHub qualification runs only from `master` against a dedicated disposable repository; stable release accepts only successful live qualification for the exact current `master` SHA.

**Tech Stack:** TypeScript, Node.js 22 `node:test`, esbuild, pnpm 9, GitHub Actions, GitHub CLI (`gh`), Obsidian API.

**Spec:** `docs/superpowers/specs/2026-08-24-release-and-e2e-hardening-design.md`

## Global Constraints

- Copy policy remains local-primary / remote-conflict-copy.
- No new runtime dependency.
- No random concurrency or correctness-by-sleep tests.
- No claim of strict server-side Git ref CAS.
- No 5 GiB physical qualification, pack-scale benchmark, or public alpha/beta channel.
- Real GitHub qualification uses a dedicated disposable repository and branch `obsidian-sync-e2e/run-${GITHUB_RUN_ID}`.
- Stable release qualifies exactly current `master`; stale/missing/skipped qualification fails closed.
- Any V4 production change requires a failing regression first.

## File Map

- `.gitignore`, `package-lock.json`, `scripts/update-version.js`, `scripts/validate-package.mjs`, `tests/v4/release-metadata.test.mjs` — package/version source of truth.
- `src/setting.tsx`, `docs/FAQ.md`, `tests/v4/conflicts.test.ts`, `tests/v4/sync-session.test.ts` — conflict contract and namespace safety.
- `tests/v4/sync-coordinator.test.ts`, `tests/v4/runtime-retry.test.ts` — causality and user-facing retry.
- `tests/github-e2e/v4-real-github-e2e.test.ts`, `docs/github-e2e.md` — live scenario coverage.
- `.github/workflows/github-e2e-live.yml` — credentialed qualification.
- `.github/workflows/pre-release.yml` — artifact-only candidate build.
- `.github/workflows/release.yml`, `docs/releasing.md`, `README.md` — stable release and maintainer flow.

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
- Produces: one-target version bump and offline release metadata validation.

- [ ] **Step 1: Write failing temp-repository tests**

Create `tests/v4/release-metadata.test.mjs` with helpers that copy the two scripts into a temporary Git repo and write canonical fixtures. Use these concrete assertions:

```js
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const run = (cwd, args, env = {}) => spawnSync(process.execPath, args, {
  cwd,
  encoding: "utf8",
  env: { ...process.env, ...env },
});
const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" });
const json = async (cwd, file) => JSON.parse(await readFile(path.join(cwd, file), "utf8"));

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ogs-release-meta-"));
  await mkdir(path.join(dir, "scripts"));
  await cp(path.join(root, "scripts/update-version.js"), path.join(dir, "scripts/update-version.js"));
  await cp(path.join(root, "scripts/validate-package.mjs"), path.join(dir, "scripts/validate-package.mjs"));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3", packageManager: "pnpm@9.12.3" }, null, 2) + "\n");
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ id: "fixture", version: "1.2.3", minAppVersion: "1.11.4" }, null, 2) + "\n");
  await writeFile(path.join(dir, "versions.json"), JSON.stringify({ "1.2.3": "1.11.4" }, null, 2) + "\n");
  await writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(path.join(dir, "main.js"), "fixture\n");
  await writeFile(path.join(dir, "styles.css"), "fixture\n");
  assert.equal(git(dir, ["init"]).status, 0);
  assert.equal(git(dir, ["add", "."]).status, 0);
  return dir;
}

test("version helper derives one target and updates package manifest versions", async () => {
  const dir = await fixture();
  const result = run(dir, ["scripts/update-version.js", "patch"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await json(dir, "package.json")).version, "1.2.4");
  assert.equal((await json(dir, "manifest.json")).version, "1.2.4");
  assert.equal((await json(dir, "versions.json"))["1.2.4"], "1.11.4");
});

test("version helper rejects drift before mutation", async () => {
  const dir = await fixture();
  const manifestPath = path.join(dir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({ id: "fixture", version: "1.2.4", minAppVersion: "1.11.4" }, null, 2) + "\n");
  const before = await Promise.all(["package.json", "manifest.json", "versions.json"].map(file => readFile(path.join(dir, file), "utf8")));
  const result = run(dir, ["scripts/update-version.js", "patch"]);
  assert.notEqual(result.status, 0);
  const after = await Promise.all(["package.json", "manifest.json", "versions.json"].map(file => readFile(path.join(dir, file), "utf8")));
  assert.deepEqual(after, before);
});

test("validator rejects wrong compatibility mapping", async () => {
  const dir = await fixture();
  await writeFile(path.join(dir, "versions.json"), JSON.stringify({ "1.2.3": "1.6.5" }, null, 2) + "\n");
  const result = run(dir, ["scripts/validate-package.mjs"]);
  assert.notEqual(result.status, 0);
});

test("validator rejects tracked alternate lockfiles", async () => {
  const dir = await fixture();
  await writeFile(path.join(dir, "package-lock.json"), "{}\n");
  assert.equal(git(dir, ["add", "package-lock.json"]).status, 0);
  const result = run(dir, ["scripts/validate-package.mjs"]);
  assert.notEqual(result.status, 0);
});

test("validator accepts canonical pnpm metadata", async () => {
  const dir = await fixture();
  const result = run(dir, ["scripts/validate-package.mjs"]);
  assert.equal(result.status, 0, result.stderr);
});
```

Add separate assertions in the same file that `update-version.js 1.2`, `update-version.js 1.2.3`, duplicate `1.2.4`, and invocation with neither CLI argument nor `NEW_VERSION` exit non-zero.

- [ ] **Step 2: Run red tests**

```bash
node scripts/run-tests.mjs --tier=fast --filter=release-metadata
```

Expected: FAIL because current helper does not update `versions.json` and current validator does not reject metadata/alternate-lock drift.

- [ ] **Step 3: Implement one-target version preflight**

In `scripts/update-version.js`, read all metadata before any write, remove `npm_package_version` fallback, compute one target from package/manifest shared current version, and reject non-increasing/duplicate targets. Add:

```js
function compareSemver(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}
```

Use this write sequence only after all preflight checks succeed:

```js
writeJsonWithBackup(packagePath, { ...pkg, version: target });
writeJsonWithBackup(manifestPath, { ...manifest, version: target });
writeJsonWithBackup(versionsPath, { ...versions, [target]: manifest.minAppVersion });
```

- [ ] **Step 4: Implement offline validator checks**

In `scripts/validate-package.mjs`, read `versions.json`, define:

```js
const STABLE_SEMVER = /^\d+\.\d+\.\d+$/u;
function tracked(file) {
  return spawnSync("git", ["ls-files", "--error-unmatch", "--", file], { stdio: "ignore" }).status === 0;
}
```

Fail with explicit messages when package/manifest versions are invalid or unequal, `manifest.minAppVersion` is invalid, `versions[manifest.version] !== manifest.minAppVersion`, packageManager is not `pnpm@...`, `pnpm-lock.yaml` is not tracked, or `package-lock.json`/`yarn.lock` is tracked. Preserve current artifact and secret checks.

- [ ] **Step 5: Remove alternate lock source**

Delete tracked `package-lock.json`. In `.gitignore`, remove the duplicate E2E-secret block and add:

```gitignore
/package-lock.json
/yarn.lock
```

- [ ] **Step 6: Run green test**

```bash
node scripts/run-tests.mjs --tier=fast --filter=release-metadata
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add .gitignore scripts/update-version.js scripts/validate-package.mjs tests/v4/release-metadata.test.mjs
git rm package-lock.json
git commit -m "build: harden release metadata tooling"
```

---

### Task 2: Define Exact Copy-Policy Conflict Semantics

**Files:**
- Modify: `src/setting.tsx`
- Modify: `docs/FAQ.md`
- Modify: `tests/v4/conflicts.test.ts`
- Modify: `tests/v4/sync-session.test.ts`
- Modify: `tests/github-e2e/v4-real-github-e2e.test.ts`

**Interfaces:**
- Consumes: `resolveV4Conflict({ policy: "copy" })` returning `keep-local-copy-remote` and current conflict-copy naming.
- Produces: exact local-primary contract across docs, settings, deterministic tests, and live E2E.

- [ ] **Step 1: Lock resolver naming**

Add/rename the unit test to:

```ts
test("v4 copy policy keeps local primary and requests a remote conflict copy", () => {
  const resolution = resolveV4Conflict({ policy: "copy", path: "a.md", localMtime: 2, remoteMtime: 3 });
  assert.equal(resolution.action, "keep-local-copy-remote");
});
```

- [ ] **Step 2: Add exact session regressions before production edits**

Using existing `MemoryGitHub`/`MemoryVault` fixtures in `tests/v4/sync-session.test.ts`, add fixed-clock tests for these final states:

```text
edit/edit: canonical shared.md = local; one conflict copy = remote; original fileId stays canonical; copy fileId differs.
remote rename old->new vs stale local edit old: old stays canonical/local/original-fileId; one conflict copy derived from new contains remote bytes; standalone new absent.
remote delete vs stale local edit: local canonical survives; original fileId survives; no conflict copy.
local delete vs remote edit: canonical path absent; remote bytes survive as one conflict copy with a distinct fileId.
```

Each test must assert exact path set, exact bytes, exact conflict-copy count, and fileId relation.

- [ ] **Step 3: Run session tests red/green**

```bash
node scripts/run-tests.mjs --tier=fast --filter=sync-session
```

If a new exact assertion fails, keep that regression red and apply the smallest production fix required by the approved contract before proceeding. If all pass, do not modify production sync behavior.

- [ ] **Step 4: Tighten live rename-vs-edit**

In `runRenameVsEditScenario`, use Device B fixed time `515151`, compute the exact expected conflict-copy path from `Notes/renamed.md`, and assert Device C sees only the canonical stale-local path plus exactly one conflict copy. Assert canonical original fileId stability and conflict-copy distinct fileId; encrypted mode must additionally pass existing opaque-object verification.

- [ ] **Step 5: Align Settings and FAQ**

Change the dropdown option to:

```ts
.addOption("copy", "Copy (keep local, preserve remote copy)")
```

Change its description to: `When both sides changed, keep this device's local file at its normal path and preserve the remote version as a conflict copy.` Update English and Chinese FAQ to state the same semantics.

- [ ] **Step 6: Verify conflict layer and harness compilation**

```bash
node scripts/run-tests.mjs --tier=fast --filter=conflicts
node scripts/run-tests.mjs --tier=fast --filter=sync-session
GITHUB_E2E_COMPILE_ONLY=1 pnpm test:github-e2e:quick
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/setting.tsx docs/FAQ.md tests/v4/conflicts.test.ts tests/v4/sync-session.test.ts tests/github-e2e/v4-real-github-e2e.test.ts
git commit -m "test: define exact V4 copy conflict contract"
```

---

### Task 3: Cross-Device Namespace and Conflict-Copy Safety

**Files:**
- Modify: `tests/v4/sync-session.test.ts`
- Modify only after red regression: `src/lib/v4/sync-session.ts`

**Interfaces:**
- Consumes: local/remote logical records.
- Produces if needed: early combined-namespace validation keyed by `path.normalize("NFC").toLowerCase()` and fileId.

- [ ] **Step 1: Write cross-side collision regressions**

Add cases where local and remote individually pass but different fileIds collide at `note.md/note.md`, `Foo.md/foo.md`, and `é.md/e\u0301.md`. Record `MemoryVault.operations` and GitHub commit count before sync. Assert sync rejects and both mutation counters remain unchanged.

Add a control where the same fileId renames `Foo.md -> foo.md`; assert that it remains a valid rename.

- [ ] **Step 2: Run regression**

```bash
node scripts/run-tests.mjs --tier=fast --filter=sync-session
```

Expected: at least one different-fileId cross-side collision is red or fails after mutation on current code. Preserve the red regression.

- [ ] **Step 3: Implement minimal combined namespace guard if red**

Add near existing collision validation:

```ts
function v4NamespaceKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function assertCombinedV4NamespaceSafe(local: V4LogicalFile[], remote: V4LogicalFile[]): void {
  const seen = new Map<string, { fileId: string; path: string }>();
  for (const file of [...remote, ...local]) {
    const key = v4NamespaceKey(file.path);
    const prior = seen.get(key);
    if (!prior) {
      seen.set(key, { fileId: file.fileId, path: file.path });
      continue;
    }
    if (prior.fileId !== file.fileId) {
      throw new Error(`V4 path collision across local/remote state: ${prior.path} vs ${file.path}`);
    }
  }
}
```

Call it after local scan and remote record filtering, before `planV4Sync` and before any pull/push mutation. Reuse existing path-normalization helper if one already implements the exact same convention.

- [ ] **Step 4: Add occupied conflict-copy regression**

Create a copy conflict at fixed time where the expected conflict-copy filename is already occupied by an unrelated fileId. Assert the unrelated file bytes/fileId are unchanged and sync refuses rather than overwriting. Do not implement numbered fallback names.

- [ ] **Step 5: Verify**

```bash
node scripts/run-tests.mjs --tier=fast --filter=sync-session
```

Expected: PASS, including legal same-fileId case-only rename.

- [ ] **Step 6: Commit**

```bash
git add tests/v4/sync-session.test.ts
if git diff --quiet -- src/lib/v4/sync-session.ts; then
  git commit -m "test: cover cross-device namespace collisions"
else
  git add src/lib/v4/sync-session.ts
  git commit -m "fix: reject ambiguous cross-device V4 paths"
fi
```

---

### Task 4: Rescan Causality and Runtime Automatic Retry

**Files:**
- Modify: `tests/v4/sync-coordinator.test.ts`
- Create: `tests/v4/runtime-retry.test.ts`
- Modify only after red regression: `src/lib/v4/sync-coordinator.ts`, `src/lib/v4/runtime.ts`

**Interfaces:**
- Consumes: `coalesceV4Changes`, `V4PluginRuntime.manualSync`, progress `attempt`.
- Produces: deterministic proof of identity-preserving rescan coalescing and one-action recoverable publication retry.

- [ ] **Step 1: Add table-driven causality cases**

Add explicit coordinator tests for `replace+rescan`, `rename+rescan`, `delete+rescan`, `folderRename+rescan`, `folderDelete+rescan`, and `delete+modify+rescan -> replace`, while retaining the existing proof that content-only modifies can collapse to one rescan.

- [ ] **Step 2: Run coordinator matrix**

```bash
node scripts/run-tests.mjs --tier=fast --filter=sync-coordinator
```

Expected: PASS for already-correct cases; any newly exposed failure stays red until minimally fixed.

- [ ] **Step 3: Build a real-runtime fake-GitHub retry fixture**

Create `tests/v4/runtime-retry.test.ts` around exported `V4PluginRuntime`. Use an in-memory plugin-shaped object with required settings/vault/index adapter/GitHub methods. Configure the fake publication path so attempt 1 advances the fake branch then throws the same recoverable stale-ref/branch-head-changed condition used by production; attempt 2 publishes successfully.

Observe progress through `runtime.subscribeProgress` and assert:

```ts
const attempts: number[] = [];
const unsubscribe = runtime.subscribeProgress(snapshot => attempts.push(snapshot.attempt));
const result = await runtime.manualSync();
unsubscribe();
assert.ok(result);
assert.equal(publishAttempts, 2);
assert.equal(Math.max(...attempts), 2);
assert.equal(runtime.progressSnapshot.lifecycle, "success");
```

The test must invoke `manualSync()` once and must use `V4PluginRuntime`, not a copied retry loop.

- [ ] **Step 4: Run runtime retry regression**

```bash
node scripts/run-tests.mjs --tier=fast --filter=runtime-retry
```

Expected: PASS if existing retry semantics are wired correctly. If red, modify only the production retry predicate/control flow proven insufficient by the test.

- [ ] **Step 5: Commit**

```bash
git add tests/v4/sync-coordinator.test.ts tests/v4/runtime-retry.test.ts
for file in src/lib/v4/sync-coordinator.ts src/lib/v4/runtime.ts; do
  git diff --quiet -- "$file" || git add "$file"
done
git commit -m "test: harden V4 causality and runtime replan coverage"
```

---

### Task 5: Harden the Live GitHub E2E Suite

**Files:**
- Modify: `tests/github-e2e/v4-real-github-e2e.test.ts`
- Modify only if required: `scripts/run-github-e2e.mjs`
- Modify: `docs/github-e2e.md`

**Interfaces:**
- Consumes existing `GITHUB_E2E_*` process env and disposable branch safety rules.
- Produces: exact multi-device assertions plus encrypted external-mutation refusal.

- [ ] **Step 1: Add encrypted external-mutation scenario**

Use existing live client helpers to: force-push encrypted V4; create an out-of-band Git commit on the same branch without changing authenticated encrypted journal/head metadata; advance branch with non-force ref update; run normal sync; assert rejection text matches encrypted external-change safety error; assert the external commit remains reachable and plugin does not publish over it.

- [ ] **Step 2: Keep manual-run safety invariant**

Do not relax current runner rejection of `main`, `master`, `production`, `prod`, `release`, or `stable` branches.

- [ ] **Step 3: Compile**

```bash
GITHUB_E2E_COMPILE_ONLY=1 pnpm test:github-e2e:quick
```

Expected: PASS.

- [ ] **Step 4: Update docs**

Document local `.env.github-e2e` usage, GitHub Actions dynamic branch behavior, encrypted external mutation coverage, and explicit exclusion of physical 5 GiB qualification.

- [ ] **Step 5: Commit**

```bash
git add tests/github-e2e/v4-real-github-e2e.test.ts docs/github-e2e.md
if ! git diff --quiet -- scripts/run-github-e2e.mjs; then git add scripts/run-github-e2e.mjs; fi
git commit -m "test: harden live GitHub E2E safety coverage"
```

---

### Task 6: Credentialed Exact-SHA Live Qualification Workflow

**Files:**
- Create: `.github/workflows/github-e2e-live.yml`
- Modify: `docs/github-e2e.md`

**Interfaces:**
- GitHub Environment `github-e2e`: vars `E2E_OWNER`, `E2E_REPO`; secret `E2E_TOKEN`.
- Stable job names: `qualify`, `cleanup`.

- [ ] **Step 1: Create workflow header and jobs**

Use exactly:

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
```

Add checkout `actions/checkout@v6`, `pnpm/action-setup@v4`, and `actions/setup-node@v6` using `.node-version`.

- [ ] **Step 2: Add source/target/stale guards before installation**

With repository `GITHUB_TOKEN` exposed as `GH_TOKEN`, run:

```bash
set -euo pipefail
test "$GITHUB_REF" = "refs/heads/master"
test -n "$GITHUB_E2E_OWNER"
test -n "$GITHUB_E2E_REPO"
test "$GITHUB_E2E_OWNER/$GITHUB_E2E_REPO" != "$GITHUB_REPOSITORY"
current_master=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/master" --jq .object.sha)
test "$current_master" = "$GITHUB_SHA"
```

- [ ] **Step 3: Run live qualification and write best-effort audit artifact**

Run frozen install, build, then `pnpm test:github-e2e:quick` without compile-only. After success write:

```bash
node -e 'const fs=require("fs"); fs.writeFileSync("github-e2e-qualification.json", JSON.stringify({schemaVersion:1,commitSha:process.env.GITHUB_SHA,workflowRunId:process.env.GITHUB_RUN_ID,runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT),qualifiedAt:new Date().toISOString(),suite:"github-e2e-quick"}, null, 2)+"\n")'
```

Upload with `actions/upload-artifact@v4`, name `github-e2e-qualification-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}`, and `continue-on-error: true`.

- [ ] **Step 4: Add separate cleanup job**

Use:

```yaml
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
```

Delete branch with a Node `fetch` script instead of fragile URL shell escaping. The script must DELETE `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, treat 204/404/422 as success, retry other responses three times with delays 2s/4s/6s, and exit non-zero if still present.

- [ ] **Step 5: Document setup**

In `docs/github-e2e.md`, state Environment name `github-e2e`, vars `E2E_OWNER`/`E2E_REPO`, secret `E2E_TOKEN`, required dedicated repository, dynamic branch, and cleanup command.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/github-e2e-live.yml docs/github-e2e.md
git commit -m "ci: add exact-SHA live GitHub qualification"
```

---

### Task 7: Remove Public Prerelease Bypass

**Files:**
- Replace: `.github/workflows/pre-release.yml`

**Interfaces:**
- Consumes non-master `manifest.json` changes/manual dispatch.
- Produces candidate artifact only.

- [ ] **Step 1: Replace workflow**

Use header:

```yaml
name: Branch Candidate Build
on:
  push:
    branches-ignore:
      - master
    paths:
      - manifest.json
  workflow_dispatch:
permissions:
  contents: read
```

Single job: checkout, pnpm/node setup, frozen install, build, `pnpm test`, repeat, recovery, resource, feasibility, E2E compile-only, package validation, upload `main.js`, `manifest.json`, `styles.css` as `candidate-${{ github.sha }}`.

- [ ] **Step 2: Prove release capabilities are absent**

```bash
for needle in 'contents: write' 'action-gh-release' 'tag_name' 'deep-translator'; do
  if grep -F "$needle" .github/workflows/pre-release.yml; then exit 1; fi
done
```

Expected: command exits 0 with no matches.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/pre-release.yml
git commit -m "ci: make prerelease workflow artifact-only"
```

---

### Task 8: Explicit Exact-SHA Stable Release

**Files:**
- Replace: `.github/workflows/release.yml`
- Create: `docs/releasing.md`
- Modify: `README.md`

**Interfaces:**
- Input: `version` in `x.y.z`.
- Authority: successful `github-e2e-live.yml` workflow-dispatch run at exact current `master` SHA with jobs `qualify` and `cleanup` successful.
- Output: stable tag/release/assets at exact qualified SHA.

- [ ] **Step 1: Replace workflow trigger/permissions**

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

Use checkout with `fetch-depth: 0`, pnpm/action-setup@v4, setup-node@v6, and `.node-version`.

- [ ] **Step 2: Add fail-closed metadata/tag/master preflight**

Run with `GH_TOKEN: ${{ github.token }}`:

```bash
set -euo pipefail
VERSION='${{ inputs.version }}'
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
test "$GITHUB_REF" = "refs/heads/master"
test "$(jq -r .version manifest.json)" = "$VERSION"
test "$(jq -r .version package.json)" = "$VERSION"
MIN_APP=$(jq -r .minAppVersion manifest.json)
test "$(jq -r --arg v "$VERSION" '.[$v]' versions.json)" = "$MIN_APP"
CURRENT_MASTER=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/master" --jq .object.sha)
test "$CURRENT_MASTER" = "$GITHUB_SHA"
if git show-ref --verify --quiet "refs/tags/$VERSION"; then exit 1; fi
if gh release view "$VERSION" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then exit 1; fi
```

Determine the highest existing stable tag with `git tag --list | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1`; compare it to requested version using a Node numeric three-component comparator and fail if requested is not greater.

- [ ] **Step 3: Query exact-SHA live qualification**

Run this Node script through `gh api` outputs or equivalent shell loop; acceptance conditions are exact: run event `workflow_dispatch`, head branch `master`, head SHA `$GITHUB_SHA`, run conclusion `success`, and both job names `qualify` and `cleanup` conclude `success`.

Concrete shell:

```bash
set -euo pipefail
qualified=false
mapfile -t run_ids < <(gh api --paginate \
  "repos/$GITHUB_REPOSITORY/actions/workflows/github-e2e-live.yml/runs?head_sha=$GITHUB_SHA&event=workflow_dispatch&status=completed&per_page=100" \
  --jq '.workflow_runs[] | select(.conclusion == "success" and .head_branch == "master") | .id')
for run_id in "${run_ids[@]}"; do
  jobs=$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$run_id/jobs?per_page=100")
  q=$(jq '[.jobs[] | select(.name == "qualify" and .conclusion == "success")] | length' <<<"$jobs")
  c=$(jq '[.jobs[] | select(.name == "cleanup" and .conclusion == "success")] | length' <<<"$jobs")
  if [ "$q" -ge 1 ] && [ "$c" -ge 1 ]; then qualified=true; break; fi
done
if [ "$qualified" != true ]; then echo "No exact-SHA live qualification" >&2; exit 1; fi
```

- [ ] **Step 4: Run deterministic gates**

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

- [ ] **Step 5: Recheck master immediately before publication**

```bash
CURRENT_MASTER=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/master" --jq .object.sha)
test "$CURRENT_MASTER" = "$GITHUB_SHA"
```

- [ ] **Step 6: Package and publish last**

Create `${{ github.event.repository.name }}-v${{ inputs.version }}.zip` containing `main.js`, `manifest.json`, `styles.css`; then run:

```bash
gh release create "$VERSION" \
  --repo "$GITHUB_REPOSITORY" \
  --target "$GITHUB_SHA" \
  --title "$VERSION" \
  --generate-notes \
  "$ZIP_PATH" main.js manifest.json styles.css
```

Do not use translation service or third-party release action. Do not auto-delete a partial publication on failure.

- [ ] **Step 7: Add maintainer docs**

Create `docs/releasing.md` with: version bump command; deterministic CI; Environment setup reference; live workflow dispatch; requirement for `qualify` and `cleanup`; stable release dispatch; partial publication inspection commands `gh release view <version>` and `git ls-remote --tags origin refs/tags/<version>`; explicit instruction to inspect before manual deletion.

Update README qualification section to distinguish deterministic CI, live real-GitHub qualification, and physical large-file evidence.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/release.yml docs/releasing.md README.md
git commit -m "ci: require exact-SHA qualification for stable release"
```

---

### Task 9: Full Verification, Review, and Delivery

**Files:**
- Review all changes after approved design commit `43ac573e1feabe39ab0a1a090d7553a2948007fc`.

**Interfaces:**
- Produces branch/PR ready for merge; live qualification remains maintainer-run if credentials are unavailable here.

- [ ] **Step 1: Attempt deterministic verification locally**

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

Record actual outputs. Network/dependency failure is a limitation, not a pass.

- [ ] **Step 2: Static workflow safety review**

Verify: candidate workflow is read-only/no release; ordinary CI has no live secrets; live workflow is dispatch-only with source-repo guard, dynamic branch, `qualify`/`cleanup`; stable release is dispatch-only, exact-SHA qualified, deterministic gates precede publication, and translation/release third-party action is gone.

- [ ] **Step 3: Diff hygiene**

```bash
git diff --check master...HEAD
git diff --stat master...HEAD
git log --oneline master..HEAD
```

Any V4 production change must have a preceding failing regression commit.

- [ ] **Step 4: Open/review PR**

Open PR `audit-hardening-2026-08-24 -> master`; inspect all changed-file patches; address concrete findings before merge.

- [ ] **Step 5: Merge deterministic-ready source**

Merge after all deterministic checks available to this environment are green. Do not create a stable release automatically.

- [ ] **Step 6: Handoff only the credentialed steps**

Provide:

```text
1. Create/use dedicated disposable E2E repo.
2. Settings → Environments → github-e2e.
3. Variables: E2E_OWNER, E2E_REPO. Secret: E2E_TOKEN.
4. Actions → GitHub E2E Live → Run workflow on master.
5. Confirm qualify and cleanup succeed.
6. If publication is desired: Actions → Stable Release → Run workflow on master with current x.y.z version.
```

Do not describe the target SHA as live-qualified until step 4-5 succeeds.
