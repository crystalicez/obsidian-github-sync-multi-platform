# Local Qualification and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a safe exact-SHA local qualification and stable-release workflow with remote qualification receipts, destructive-E2E isolation, deterministic cross-platform artifacts, atomic create-only stable-tag claiming, explicit draft publication, and byte-level release verification.

**Architecture:** Keep orchestration thin and split reusable concerns into focused modules: release metadata/toolchain validation, canonical GitHub-repository parsing, E2E environment safety, Git/ref/receipt handling, deterministic packaging, and GitHub publication-state inspection. `qualify:local` publishes one annotated qualification object only after every gate and cleanup check; `release:local` atomically creates the stable ref through GitHub's create-reference API, creates an explicit draft, verifies exact assets, rechecks exact evidence/master state, publishes the draft, and post-verifies it.

**Tech Stack:** Node.js v22.11.0, ESM `.mjs`, pnpm 9.12.3 through Corepack, Node built-in `node:test`, Git CLI, GitHub CLI, GitHub REST Git References API, `fflate@0.8.3`, existing feasibility test tier.

**Spec:** `docs/superpowers/specs/2026-08-26-local-qualification-and-release-design.md`

## Global Constraints

- Canonical repository is exactly `crystalicez/obsidian-github-sync-multi-platform`.
- Official local qualification runs only on clean `master` where local `HEAD` equals remote `refs/heads/master`.
- Running Node must equal `.node-version` exactly: `v22.11.0`.
- Running pnpm must equal the version in `package.json#packageManager`: `9.12.3`.
- Qualification authority is a remote annotated tag object at `refs/tags/qualification/local/v1/<version>/<sha>` whose object directly targets the exact commit.
- Stable release tags remain lightweight canonical `x.y.z` refs and are never force-updated.
- Stable-tag ownership must be an atomic **create-only** operation. A pre-existing same-SHA ref is not success for the current invocation.
- Destructive E2E must never target the source repository and official qualification must use a unique run-specific E2E branch.
- A remote lookup error is never equivalent to absence; only a proven missing ref or a successful complete release-list lookup with no match counts as absent.
- Stable publication is `stable-ref claim -> explicit draft -> exact asset verification -> final recheck -> explicit publish -> post-verification`.
- Never auto-delete, auto-clobber, force-update, or silently resume partial stable publication state.
- Release assets are exactly `main.js`, `manifest.json`, `styles.css`, and `obsidian-github-sync-multi-platform-v<version>.zip`.
- ZIP root is exactly `obsidian-github-sync-multi-platform/`; ZIP entry separators are `/` on every OS.
- `manifest.json` and `styles.css` release bytes come from the committed `HEAD` Git blobs, not from checkout-transformed working-tree bytes. `.gitattributes` additionally pins their checkout EOL to LF.
- Process-heavy release tests live under `tests/feasibility/`; do not create a new `tests/release/` tier.
- `.github/workflows/github-e2e-live.yml` and `.github/workflows/release.yml` retain their current authority and behavior.

---

## File Map

**Create**

- `scripts/release-metadata.mjs` — canonical stable-version parsing, metadata validation, and committed toolchain declarations.
- `scripts/validate-release-metadata.mjs` — metadata-only CLI.
- `scripts/github-repo.mjs` — canonical GitHub origin parsing/redaction used by E2E and release tooling.
- `scripts/github-e2e-env.mjs` — `.env.github-e2e` parsing, destructive-target safety, and unique qualification branch generation.
- `scripts/local-release-lib.mjs` — receipt constants/schema plus shared command/gate helpers.
- `scripts/local-release-git.mjs` — clean/master checks, remote Git reads, qualification tag-object creation/inspection, and committed-blob reads.
- `scripts/local-release-github.mjs` — atomic stable-ref create, complete release-state lookup, draft/publish argv, and remote asset verification.
- `scripts/local-qualify.mjs` — qualification orchestration only.
- `scripts/package-plugin.mjs` — deterministic staged release assets, ZIP, and local SHA-256 artifact manifest.
- `scripts/local-release.mjs` — publication state machine only.
- `.gitattributes` — targeted LF policy for direct-upload tracked text assets.
- `tests/feasibility/release-metadata.test.mjs`
- `tests/feasibility/github-e2e-safety.test.mjs`
- `tests/feasibility/local-release-lib.test.mjs`
- `tests/feasibility/local-release-git.test.mjs`
- `tests/feasibility/local-qualify.test.mjs`
- `tests/feasibility/package-plugin.test.mjs`
- `tests/feasibility/local-release-github.test.mjs`
- `tests/feasibility/local-release.test.mjs`

**Modify**

- `scripts/validate-package.mjs` — reuse metadata validation while preserving built-artifact, lockfile, and secret checks.
- `scripts/run-github-e2e.mjs` — reuse shared env/repository safety before destructive execution.
- `package.json` — add `validate:metadata`, `qualify:local`, `release:local`, and exact `fflate` development dependency.
- `pnpm-lock.yaml` — lock `fflate@0.8.3`.
- `docs/releasing.md`
- `docs/github-e2e.md`
- `.env.github-e2e.example`

---

### Task 1: Canonical Metadata, Version, and Toolchain Validation

**Files:**
- Create: `scripts/release-metadata.mjs`
- Create: `scripts/validate-release-metadata.mjs`
- Modify: `scripts/validate-package.mjs`
- Test: `tests/feasibility/release-metadata.test.mjs`
- Test: `tests/feasibility/validate-package.test.mjs`

**Interfaces:**
- Produces: `parseStableVersion(value) -> [bigint,bigint,bigint] | null`
- Produces: `compareStableVersions(a,b) -> -1 | 0 | 1`
- Produces: `readReleaseMetadata(cwd) -> Promise<{packageJson,manifest,versions,nodeVersion,pnpmVersion}>`
- Produces: `validateReleaseMetadata(metadata,{requestedVersion?}) -> {version,minAppVersion,nodeVersion,pnpmVersion}`

- [ ] **Step 1: Write failing version/metadata tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  compareStableVersions,
  parseStableVersion,
  validateReleaseMetadata,
} from "../../scripts/release-metadata.mjs";

test("stable versions are canonical numeric triples", () => {
  assert.deepEqual(parseStableVersion("1.0.8"), [1n, 0n, 8n]);
  assert.equal(parseStableVersion("01.0.8"), null);
  assert.equal(parseStableVersion("1.0.8-beta.1"), null);
  assert.equal(parseStableVersion("v1.0.8"), null);
});

test("stable comparison remains exact beyond Number.MAX_SAFE_INTEGER", () => {
  assert.equal(compareStableVersions("9007199254740993.0.0", "9007199254740992.999.999"), 1);
});

test("metadata returns exact committed toolchain declarations", () => {
  const result = validateReleaseMetadata({
    packageJson: { version: "1.0.8", packageManager: "pnpm@9.12.3+sha512.deadbeef" },
    manifest: { id: "encrypted-github-sync-multi-platform", version: "1.0.8", minAppVersion: "1.11.4" },
    versions: { "1.0.8": "1.11.4" },
    nodeVersion: "v22.11.0",
  });
  assert.equal(result.version, "1.0.8");
  assert.equal(result.nodeVersion, "v22.11.0");
  assert.equal(result.pnpmVersion, "9.12.3");
});
```

- [ ] **Step 2: Prove the new test fails**

```bash
node --test tests/feasibility/release-metadata.test.mjs
```

Expected: FAIL because `scripts/release-metadata.mjs` does not exist.

- [ ] **Step 3: Implement exact stable parsing and metadata validation**

```js
const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function parseStableVersion(value) {
  const match = STABLE_VERSION_RE.exec(value);
  return match ? [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])] : null;
}

export function compareStableVersions(a, b) {
  const left = parseStableVersion(a);
  const right = parseStableVersion(b);
  if (!left || !right) throw new Error(`Cannot compare non-canonical stable versions: ${a}, ${b}`);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

export function declaredPnpmVersion(packageManager) {
  const match = /^pnpm@([^+]+)(?:\+.+)?$/u.exec(packageManager ?? "");
  if (!match) throw new Error("packageManager must declare pnpm@<version>");
  return match[1];
}
```

`validateReleaseMetadata` rejects mismatched package/manifest versions, malformed stable versions, missing or mismatched `versions[version]`, invalid `minAppVersion`, missing plugin id, and invalid `packageManager`.

- [ ] **Step 4: Add metadata CLI and refactor `validate-package.mjs`**

```js
import { readReleaseMetadata, validateReleaseMetadata } from "./release-metadata.mjs";

const result = validateReleaseMetadata(await readReleaseMetadata(process.cwd()));
console.log(`Validated release metadata for v${result.version}`);
```

`validate-package.mjs` imports the same metadata validator but retains all existing checks for `main.js`/`manifest.json`/`styles.css`, canonical lockfile tracking, alternate lockfiles, tracked secrets, and local-secret ignore status.

- [ ] **Step 5: Run focused regressions**

```bash
node --test tests/feasibility/release-metadata.test.mjs tests/feasibility/validate-package.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/release-metadata.mjs scripts/validate-release-metadata.mjs scripts/validate-package.mjs tests/feasibility/release-metadata.test.mjs tests/feasibility/validate-package.test.mjs
git commit -m "feat: add release metadata validation"
```

---

### Task 2: Canonical Repository Parsing and Destructive E2E Safety

**Files:**
- Create: `scripts/github-repo.mjs`
- Create: `scripts/github-e2e-env.mjs`
- Modify: `scripts/run-github-e2e.mjs`
- Test: `tests/feasibility/github-e2e-safety.test.mjs`

**Interfaces:**
- Produces: `CANONICAL_REPOSITORY = "crystalicez/obsidian-github-sync-multi-platform"`.
- Produces: `normalizeGitHubRemote(url) -> "owner/repo"` and `requireCanonicalOrigin({runner,cwd})`.
- Produces: `parseEnvLine`, `loadGitHubE2EEnv`, `validateGitHubE2EConfig`, `qualificationE2EBranch`.

- [ ] **Step 1: Write failing canonical-origin and E2E safety tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGitHubRemote } from "../../scripts/github-repo.mjs";
import { qualificationE2EBranch, validateGitHubE2EConfig } from "../../scripts/github-e2e-env.mjs";

test("canonical remote parser accepts supported GitHub forms", () => {
  assert.equal(normalizeGitHubRemote("https://github.com/crystalicez/obsidian-github-sync-multi-platform.git"), "crystalicez/obsidian-github-sync-multi-platform");
  assert.equal(normalizeGitHubRemote("git@github.com:crystalicez/obsidian-github-sync-multi-platform.git"), "crystalicez/obsidian-github-sync-multi-platform");
  assert.equal(normalizeGitHubRemote("ssh://git@github.com/crystalicez/obsidian-github-sync-multi-platform.git"), "crystalicez/obsidian-github-sync-multi-platform");
});

test("canonical remote parser rejects credentials and lookalike hosts", () => {
  assert.throws(() => normalizeGitHubRemote("https://token@github.com/crystalicez/obsidian-github-sync-multi-platform.git"));
  assert.throws(() => normalizeGitHubRemote("https://github.com.evil/crystalicez/obsidian-github-sync-multi-platform.git"));
});

test("destructive E2E rejects the source repository", () => {
  assert.throws(() => validateGitHubE2EConfig({
    owner: "Crystalicez",
    repo: "obsidian-github-sync-multi-platform",
    branch: "e2e-destructive",
    token: "secret",
    sourceRepo: "crystalicez/obsidian-github-sync-multi-platform",
  }), /source repository/i);
});

test("qualification branch is run-specific", () => {
  assert.equal(qualificationE2EBranch("a".repeat(40), "run-a"), "obsidian-sync-e2e/local-aaaaaaaaaaaa-run-a");
});
```

Also cover protected branch names, missing credentials, case-insensitive source repo equality, unsafe random IDs, and `.env` shell-env-wins behavior.

- [ ] **Step 2: Prove failure**

```bash
node --test tests/feasibility/github-e2e-safety.test.mjs
```

Expected: FAIL because the new modules do not exist.

- [ ] **Step 3: Implement canonical parsing and env helpers**

Only `github.com` is accepted. Remove one optional `.git` suffix; reject userinfo in HTTPS URLs, non-default host/port variants, extra path segments, and non-GitHub hosts. Diagnostic errors must never echo a credential-bearing raw URL.

Move the existing env-line/file parsing from `run-github-e2e.mjs` into `github-e2e-env.mjs` without changing shell-env-wins semantics.

- [ ] **Step 4: Wire source-repo rejection into the existing live runner**

Before destructive bundling/execution, `run-github-e2e.mjs` calls `requireCanonicalOrigin`, loads E2E config, and calls `validateGitHubE2EConfig`. `--compile-only` remains credential-free and does not require GitHub configuration.

Do not alter any E2E scenario file or V4 runtime behavior.

- [ ] **Step 5: Run safety and compile-only regressions**

```bash
node --test tests/feasibility/github-e2e-safety.test.mjs tests/feasibility/github-e2e-compile-cli.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/github-repo.mjs scripts/github-e2e-env.mjs scripts/run-github-e2e.mjs tests/feasibility/github-e2e-safety.test.mjs
git commit -m "fix: harden destructive github e2e configuration"
```

---

### Task 3: Qualification Receipt, Process Runner, and Remote Git Object Primitives

**Files:**
- Create: `scripts/local-release-lib.mjs`
- Create: `scripts/local-release-git.mjs`
- Test: `tests/feasibility/local-release-lib.test.mjs`
- Test: `tests/feasibility/local-release-git.test.mjs`

**Interfaces:**
- Produces: `QUALIFICATION_GATES`, `qualificationTagName`, `createQualificationReceipt`, `validateQualificationReceipt`.
- Produces: `runCommand(command,args,options)` for shell-free Git/GitHub executables and `runPnpmGate(gate,{cwd,env})` for allowlisted Corepack commands.
- Produces: `lookupRemoteRef`, `readRemoteMasterSha`, `readHeadSha`, `requireCleanMaster`, `readCommittedBlob`.
- Produces: `createAnnotatedTagObject` and `inspectTagObject`.

- [ ] **Step 1: Write failing receipt tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  QUALIFICATION_GATES,
  createQualificationReceipt,
  qualificationTagName,
  validateQualificationReceipt,
} from "../../scripts/local-release-lib.mjs";

const sha = "a".repeat(40);

test("v1 receipt has exact authority fields and gate order", () => {
  const receipt = createQualificationReceipt({
    sha,
    version: "1.0.8",
    qualifiedAt: "2026-08-27T00:00:00.000Z",
    durationMs: 1000,
    platform: "linux-x64",
    nodeVersion: "v22.11.0",
    pnpmVersion: "9.12.3",
  });
  assert.equal(qualificationTagName("1.0.8", sha), `qualification/local/v1/1.0.8/${sha}`);
  assert.deepEqual(receipt.gates, QUALIFICATION_GATES);
  assert.doesNotThrow(() => validateQualificationReceipt(receipt, {
    sha, version: "1.0.8", nodeVersion: "v22.11.0", pnpmVersion: "9.12.3",
  }));
});

test("receipt rejects reordered gates", () => {
  const receipt = createQualificationReceipt({
    sha, version: "1.0.8", qualifiedAt: "2026-08-27T00:00:00.000Z", durationMs: 1,
    platform: "linux-x64", nodeVersion: "v22.11.0", pnpmVersion: "9.12.3",
  });
  assert.throws(() => validateQualificationReceipt({ ...receipt, gates: [...receipt.gates].reverse() }, {
    sha, version: "1.0.8", nodeVersion: "v22.11.0", pnpmVersion: "9.12.3",
  }), /gates/i);
});
```

Add duplicate/missing/extra gate, wrong schema/kind/repository/SHA/version/result/toolchain, invalid timestamp/duration/platform cases.

- [ ] **Step 2: Write real temporary-Git object tests**

Create a temp Git repo, configure a test identity, commit once, create an annotated tag object via the intended `git mktag` helper, and assert:

```js
const inspected = inspectTagObject({ runner: runCommand, cwd, objectSha });
assert.equal(inspected.targetType, "commit");
assert.equal(inspected.targetSha, commitSha);
assert.equal(inspected.tagName, expectedTagName);
```

Create a tag-to-tag object and prove the validator rejects `targetType === "tag"`. Create a bare temp remote and test remote-ref present/absent/error classification.

- [ ] **Step 3: Prove tests fail**

```bash
node --test tests/feasibility/local-release-lib.test.mjs tests/feasibility/local-release-git.test.mjs
```

Expected: FAIL because helper modules do not exist.

- [ ] **Step 4: Implement exact receipt contract**

```js
export const QUALIFICATION_GATES = Object.freeze([
  "metadata-validation",
  "install-frozen",
  "build",
  "package-validation",
  "fast-tests",
  "repeat-tests",
  "recovery-tests",
  "resource-tests",
  "feasibility-tests",
  "github-e2e-compile",
  "github-e2e-live",
  "github-e2e-cleanup-verified",
]);
```

Require exact array equality, not set-only equality.

- [ ] **Step 5: Implement process execution with an explicit Windows Corepack boundary**

Git and GitHub CLI commands use `spawnSync(command,args,{shell:false,...})`.

Corepack gate commands are allowlisted constants only. On POSIX spawn `corepack` with argv. On Windows invoke the fixed allowlisted command through `cmd.exe`, because Node documents `.cmd` files as requiring a terminal. No version, path, branch, token, or other user/config value is concatenated into the Windows command string.

Example shape:

```js
const PNPM_GATE_COMMANDS = Object.freeze({
  "install-frozen": "corepack pnpm install --frozen-lockfile",
  build: "corepack pnpm build",
  "package-validation": "corepack pnpm validate:package",
  "fast-tests": "corepack pnpm test",
  "repeat-tests": "corepack pnpm test:repeat",
  "recovery-tests": "corepack pnpm test:recovery",
  "resource-tests": "corepack pnpm test:resource",
  "feasibility-tests": "corepack pnpm test:feasibility",
  "github-e2e-compile": "corepack pnpm test:github-e2e:compile",
  "github-e2e-live": "corepack pnpm test:github-e2e:quick",
});
```

Tests inject `platform: "win32"` and assert `cmd.exe /d /s /c <fixed allowlisted command>` construction without interpolated dynamic values.

- [ ] **Step 6: Implement remote Git tri-state reads and committed-blob reads**

```js
const result = runner("git", ["ls-remote", remote, ref], { cwd, encoding: "utf8" });
if (result.status !== 0) throw new Error(`Remote ref lookup failed for ${ref}`);
const lines = result.stdout.trim() ? result.stdout.trim().split(/\r?\n/u) : [];
if (lines.length === 0) return { kind: "absent" };
if (lines.length !== 1) throw new Error(`Ambiguous remote ref response for ${ref}`);
return { kind: "present", objectSha: lines[0].split(/\s+/u)[0] };
```

`readCommittedBlob(cwd,path)` uses `git show HEAD:<path>` with binary output; it never reads a same-named local tag/ref as authority.

- [ ] **Step 7: Run focused tests**

```bash
node --test tests/feasibility/local-release-lib.test.mjs tests/feasibility/local-release-git.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/local-release-lib.mjs scripts/local-release-git.mjs tests/feasibility/local-release-lib.test.mjs tests/feasibility/local-release-git.test.mjs
git commit -m "feat: add local qualification authority primitives"
```

---

### Task 4: `qualify:local` Orchestration

**Files:**
- Create: `scripts/local-qualify.mjs`
- Create: `tests/feasibility/local-qualify.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `qualifyLocal({cwd,runner,now,randomId}) -> Promise<{sha,version,qualificationRef,qualificationTagObjectSha,alreadyQualified}>`.
- Produces public CLI: `pnpm qualify:local`.

- [ ] **Step 1: Write failing orchestration tests with an event-log fake runner**

```js
const events = [];
const result = await qualifyLocal({
  cwd: "/repo",
  runner: fakeRunner(events),
  now: () => new Date("2026-08-27T00:00:00.000Z"),
  randomId: () => "unit-test-run",
});
assert.deepEqual(events.filter(x => x.kind === "gate").map(x => x.name), [
  "metadata-validation",
  "install-frozen",
  "build",
  "package-validation",
  "fast-tests",
  "repeat-tests",
  "recovery-tests",
  "resource-tests",
  "feasibility-tests",
  "github-e2e-compile",
  "github-e2e-live",
  "github-e2e-cleanup-verified",
]);
assert.equal(result.version, "1.0.8");
```

Add tests for wrong Node/pnpm before gates, missing Git identity before gates, already-valid remote receipt short-circuit, invalid existing receipt rejection, build-before-package-validation, unique child E2E branch override, source-repo target rejection, branch-still-present after live E2E, master movement after gates, and exact tag-object reconciliation after ambiguous qualification push.

- [ ] **Step 2: Prove failure**

```bash
node --test tests/feasibility/local-qualify.test.mjs
```

Expected: FAIL because `local-qualify.mjs` does not exist.

- [ ] **Step 3: Implement cheap preflight before long gates**

Order:

```text
clean tree -> master -> HEAD -> canonical origin -> remote master -> metadata -> exact Node/pnpm -> Git tagger identity -> qualification-ref absence/validity -> E2E config/source-target safety
```

A valid existing remote qualification receipt returns success without rerunning gates. Any invalid same-name receipt fails closed.

- [ ] **Step 4: Run gates in exact receipt order**

Metadata validation is the first logical gate. Use `runPnpmGate` for the fixed Corepack gates. For live E2E, child env overrides only `GITHUB_E2E_BRANCH` with `obsidian-sync-e2e/local-<sha12>-<random-id>`; do not rewrite `.env.github-e2e`.

- [ ] **Step 5: Prove E2E branch cleanup before receipt publication**

After live E2E returns zero, perform a read-only GitHub branch-ref lookup with the E2E token and require proven absence. A still-present branch or unknown lookup fails qualification.

- [ ] **Step 6: Revalidate and publish one annotated qualification object**

Recheck clean state, `HEAD`, remote master, metadata/toolchain, and qualification-ref absence. Create the tag object with `git mktag`, push that exact object to the qualification ref without force, then re-read the remote ref.

An ambiguous push reconciles as success only when the remote ref object SHA exactly equals this invocation's tag-object SHA and the receipt still validates.

- [ ] **Step 7: Add package scripts**

```json
{
  "scripts": {
    "validate:metadata": "node scripts/validate-release-metadata.mjs",
    "qualify:local": "node scripts/local-qualify.mjs"
  }
}
```

Preserve existing scripts.

- [ ] **Step 8: Run qualification tests**

```bash
node --test tests/feasibility/local-qualify.test.mjs tests/feasibility/local-release-git.test.mjs tests/feasibility/github-e2e-safety.test.mjs
corepack pnpm test:github-e2e:compile
```

Expected: PASS; no real GitHub mutation in feasibility tests.

- [ ] **Step 9: Commit**

```bash
git add scripts/local-qualify.mjs tests/feasibility/local-qualify.test.mjs package.json
git commit -m "feat: add exact-sha local qualification command"
```

---

### Task 5: Deterministic Cross-Platform Staging and Plugin ZIP

**Files:**
- Create: `scripts/package-plugin.mjs`
- Create: `tests/feasibility/package-plugin.test.mjs`
- Create: `.gitattributes`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `packagePlugin({cwd,version,runner}) -> Promise<{stagingDir,zipPath,assets}>`.
- Artifact record: `{name,path,size,sha256}` with lowercase raw 64-hex SHA-256.

- [ ] **Step 1: Add exact ZIP dependency and targeted attributes**

Add exact dev dependency:

```json
"fflate": "0.8.3"
```

Create:

```gitattributes
/manifest.json text eol=lf
/styles.css text eol=lf
```

Run:

```bash
corepack pnpm install
```

Expected: lockfile contains `fflate@0.8.3`.

- [ ] **Step 2: Write failing packaging tests including checkout-EOL independence**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { packagePlugin } from "../../scripts/package-plugin.mjs";

test("package is repository-rooted and byte-repeatable", async () => {
  const first = await packagePlugin({ cwd: fixtureDir, version: "1.0.8", runner });
  const a = await readFile(first.zipPath);
  const second = await packagePlugin({ cwd: fixtureDir, version: "1.0.8", runner });
  const b = await readFile(second.zipPath);
  assert.deepEqual(b, a);
  assert.deepEqual(Object.keys(unzipSync(a)), [
    "obsidian-github-sync-multi-platform/main.js",
    "obsidian-github-sync-multi-platform/manifest.json",
    "obsidian-github-sync-multi-platform/styles.css",
  ]);
});
```

Add a temp-Git fixture where committed `manifest.json`/`styles.css` contain LF but working-tree copies are deliberately CRLF while Git's normalized content still represents the same commit. Assert staged release bytes equal `git show HEAD:manifest.json` / `HEAD:styles.css`, not the checkout-transformed bytes.

Also assert exactly four assets, `.tmp/release/1.0.8/` output, unrelated-file exclusion, canonical version input, exact sizes/digests, and ZIP date header corresponding to local `1980-01-01 00:00:00`.

- [ ] **Step 3: Prove failure**

```bash
node --test tests/feasibility/package-plugin.test.mjs
```

Expected: FAIL because the packager does not exist.

- [ ] **Step 4: Implement deterministic staging**

Stage under `.tmp/release/<version>/`:

- `main.js`: current post-build raw bytes.
- `manifest.json`: `readCommittedBlob("manifest.json")` from exact `HEAD`.
- `styles.css`: `readCommittedBlob("styles.css")` from exact `HEAD`.

This makes direct upload bytes independent of `core.autocrlf`, clean/smudge filters, and pre-existing Windows checkout state.

- [ ] **Step 5: Implement ZIP with fixed names/order/metadata**

```js
import { zipSync } from "fflate";

const RELEASE_ROOT = "obsidian-github-sync-multi-platform";
const names = ["main.js", "manifest.json", "styles.css"];
const archiveInput = Object.create(null);
for (const name of names) {
  archiveInput[`${RELEASE_ROOT}/${name}`] = [stagedBytes.get(name), {
    level: 9,
    mtime: new Date(1980, 0, 1, 0, 0, 0),
    os: 0,
  }];
}
const zipBytes = zipSync(archiveInput, { level: 9, mtime: new Date(1980, 0, 1, 0, 0, 0), os: 0 });
```

Use flat forward-slash keys only. `fflate` encodes ZIP date fields from the local `Date` components, so the local constructor above intentionally yields the same DOS date/time fields across time zones.

- [ ] **Step 6: Run package regression and normal package validation**

```bash
node --test tests/feasibility/package-plugin.test.mjs
corepack pnpm build
corepack pnpm validate:package
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/package-plugin.mjs tests/feasibility/package-plugin.test.mjs .gitattributes package.json pnpm-lock.yaml
git commit -m "feat: add deterministic plugin release packaging"
```

---

### Task 6: Atomic Stable-Ref Claim and GitHub Release/Asset Helpers

**Files:**
- Create: `scripts/local-release-github.mjs`
- Create: `tests/feasibility/local-release-github.test.mjs`

**Interfaces:**
- Produces: `createStableRef({runner,repo,version,sha}) -> {kind:"created"}|{kind:"ambiguous"}`; explicit/pre-existing state never returns success.
- Produces: `readReleaseState({runner,repo,version}) -> {kind:"absent"}|{kind:"present",release}`.
- Produces: `verifyReleaseAssets({release,localArtifacts,fetchAssetBytes}) -> Promise<void>`.
- Produces: `createDraftArgs` and `publishDraftArgs`.

- [ ] **Step 1: Write failing create-only stable-ref tests**

```js
test("stable ref creation uses GitHub create-reference API", () => {
  const result = createStableRef({
    runner: fakeGh({ status: 0, stdout: JSON.stringify({ ref: "refs/tags/1.0.8", object: { sha } }) }),
    repo: "crystalicez/obsidian-github-sync-multi-platform",
    version: "1.0.8",
    sha,
  });
  assert.equal(result.kind, "created");
});

test("same-sha concurrent ref is not claimed by this invocation", () => {
  const runner = fakeGhSequence([
    { status: 1, stderr: "HTTP 422" },
    { status: 0, stdout: JSON.stringify({ ref: "refs/tags/1.0.8", object: { sha } }) },
  ]);
  assert.throws(() => createStableRef({ runner, repo: CANONICAL_REPOSITORY, version: "1.0.8", sha }), /partial|concurrent|ambiguous/i);
});
```

The create command is the argv equivalent of:

```text
gh api --method POST repos/crystalicez/obsidian-github-sync-multi-platform/git/refs -f ref=refs/tags/1.0.8 -f sha=<exact-sha>
```

A zero exit is ownership because the REST endpoint is create-only. Any nonzero/transport outcome is inspected and then stops; observing an exact same-SHA ref after failure is partial/ambiguous state, not success.

- [ ] **Step 2: Write release-list and asset-integrity tests**

Use a successful complete paginated list as the only release-absence proof:

```text
gh api --paginate --slurp repos/crystalicez/obsidian-github-sync-multi-platform/releases?per_page=100
```

Test draft and published matches, lookup failures, missing/extra/duplicate assets, wrong size, wrong `sha256:<hex>` digest, incomplete asset state, and digest-absent fallback that downloads the remote bytes and hashes them locally.

- [ ] **Step 3: Prove failure**

```bash
node --test tests/feasibility/local-release-github.test.mjs
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 4: Implement create-only ref claim and complete release lookup**

Never use ordinary `git push <sha>:refs/tags/<version>` as the ownership primitive: an already-existing same-SHA ref can be reported as up to date. Use only GitHub's create-reference endpoint for the stable claim.

`readReleaseState` flattens every page from `--slurp`, rejects duplicate matching tag entries, and distinguishes successful no-match from command failure.

- [ ] **Step 5: Implement exact asset verification**

Accept remote digest only as `sha256:<64-hex>`. Compare exact asset-name set, uploaded/completed state, byte size, and SHA-256.

If digest is absent, invoke `gh api` for the asset API URL with `Accept: application/octet-stream`, capture binary stdout directly through `spawnSync`/runner, hash it in memory, and compare. Do not use shell redirection or write secrets.

- [ ] **Step 6: Implement draft/publish argv builders**

```js
[
  "release", "create", version,
  "--repo", repo,
  "--verify-tag",
  "--draft",
  "--title", version,
  "--generate-notes",
  ...(previousStableTag ? ["--notes-start-tag", previousStableTag] : []),
  ...assetPaths,
]
```

Publish:

```js
["release", "edit", version, "--repo", repo, "--draft=false"]
```

No `--clobber`, delete, or non-draft asset-create path exists.

- [ ] **Step 7: Run tests and commit**

```bash
node --test tests/feasibility/local-release-github.test.mjs
git add scripts/local-release-github.mjs tests/feasibility/local-release-github.test.mjs
git commit -m "feat: add atomic stable ref and release verification helpers"
```

---

### Task 7: `release:local` Publication State Machine

**Files:**
- Create: `scripts/local-release.mjs`
- Create: `tests/feasibility/local-release.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `releaseLocal({cwd,version,runner}) -> Promise<{version,sha,qualificationTagObjectSha,releaseUrl}>`.
- Produces public CLI: `pnpm release:local -- <version>`.

- [ ] **Step 1: Write failing state-machine tests**

```js
test("release reaches publish only after draft verification and final evidence recheck", async () => {
  const events = [];
  await releaseLocal({ cwd: "/repo", version: "1.0.8", runner: fakeReleaseRunner(events) });
  assert.deepEqual(events.filter(x => x.phase).map(x => x.phase), [
    "preflight",
    "publication-gates",
    "package",
    "final-pre-mutation-check",
    "tag-claim",
    "draft-create",
    "asset-verify",
    "final-evidence-check",
    "publish",
    "post-verify",
  ]);
});
```

Add tests for metadata mismatch, non-monotonic version, invalid/unqualified SHA, nested/lightweight qualification tag, qualification tag-object replacement with same peeled SHA, stale local qualification ref, pre-existing stable ref, pre-existing draft/published release, create-ref nonzero with same-SHA remote ref, ambiguous draft create, wrong/extra asset, master movement, final qualification-object movement, ambiguous publish reconciliation, and mandatory post-verification after a zero exit.

- [ ] **Step 2: Prove failure**

```bash
node --test tests/feasibility/local-release.test.mjs
```

Expected: FAIL because `local-release.mjs` does not exist.

- [ ] **Step 3: Implement preflight and qualification snapshot**

Order:

```text
version arg -> clean/master/canonical origin -> HEAD==remote master -> metadata/toolchain -> all remote stable refs -> monotonicity -> requested stable-ref absence -> complete draft/published release absence -> remote qualification object validation -> snapshot qualificationTagObjectSha
```

Enumerate all remote tags with `git ls-remote --tags origin`; filter only canonical `x.y.z` refs through `parseStableVersion`.

- [ ] **Step 4: Run publication-machine gates and stage exact assets**

Run exactly:

```text
install-frozen
build
package-validation
fast-tests
github-e2e-compile
```

Then call `packagePlugin`. Re-read metadata, clean tree, `HEAD`, remote master, qualification object SHA, stable-ref absence, and release absence before first mutation.

- [ ] **Step 5: Atomically claim the stable ref**

Call Task 6 `createStableRef`. Only a zero-exit create operation plus a follow-up exact ref read may proceed. Any nonzero/unknown result stops for inspection even if the ref is found at the expected SHA.

- [ ] **Step 6: Create explicit draft and verify exact remote assets**

Use only `createDraftArgs`. On zero exit, re-read the draft and verify all four assets. On nonzero/unknown exit, inspect and stop; never retry, delete, or clobber.

- [ ] **Step 7: Final evidence/race recheck immediately before publish**

Require:

```js
currentHead === initialHead
remoteMaster === initialHead
currentQualificationRefObjectSha === qualificationTagObjectSha
qualification.targetType === "commit"
qualification.targetSha === initialHead
stableTagSha === initialHead
release.isDraft === true
release.isPrerelease === false
```

Re-run exact asset verification against the in-memory local artifact manifest.

- [ ] **Step 8: Publish and post-verify**

Invoke explicit draft-to-published edit. Regardless of CLI exit code, final success requires a fresh remote read proving unchanged qualification object, exact stable tag SHA, non-draft/non-prerelease release, and exact four byte-matching assets.

A nonzero publish result reconciles only if all final assertions are proven. Otherwise fail with read-only inspection commands and leave state untouched.

- [ ] **Step 9: Add public script**

```json
"release:local": "node scripts/local-release.mjs"
```

Require exactly one canonical version argument.

- [ ] **Step 10: Run focused publication tests**

```bash
node --test tests/feasibility/local-release.test.mjs tests/feasibility/local-release-github.test.mjs tests/feasibility/local-release-git.test.mjs tests/feasibility/package-plugin.test.mjs
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add scripts/local-release.mjs tests/feasibility/local-release.test.mjs package.json
git commit -m "feat: add fail-closed local release state machine"
```

---

### Task 8: Maintainer Documentation and Full Verification

**Files:**
- Modify: `docs/releasing.md`
- Modify: `docs/github-e2e.md`
- Modify: `.env.github-e2e.example`
- Verify: all Tasks 1-7 files.

- [ ] **Step 1: Document the official local workflow and prerequisites**

Document:

```text
corepack pnpm install --frozen-lockfile
pnpm qualify:local
pnpm release:local -- 1.0.8
```

Prerequisites: clean `master`, Node v22.11.0, pnpm 9.12.3, Git tagger identity, Git auth for qualification-tag push, GitHub CLI Contents-write auth for create-ref/release publication, and a dedicated disposable E2E repository.

Explain state flow:

```text
qualification receipt -> create-only stable ref -> explicit draft -> verified assets -> published release -> post-verification
```

Pre-existing stable refs/drafts are inspection-only in v1; no auto-resume/delete.

- [ ] **Step 2: Document E2E source-repo rejection and official branch override**

Add to `.env.github-e2e.example`:

```text
# Manual E2E branch. pnpm qualify:local overrides this with a unique run-specific branch.
GITHUB_E2E_BRANCH=e2e-destructive
```

Explain `obsidian-sync-e2e/local-<sha12>-<random-id>` and cleanup verification.

- [ ] **Step 3: Run the full deterministic verification suite**

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm validate:package
corepack pnpm test
corepack pnpm test:repeat
corepack pnpm test:recovery
corepack pnpm test:resource
corepack pnpm test:feasibility
corepack pnpm test:github-e2e:compile
```

Expected: every command exits 0.

Do not run real `qualify:local` or `release:local` as ordinary implementation tests. Real qualification occurs deliberately after merge to the final `master` SHA.

- [ ] **Step 4: Run focused release-safety tests explicitly**

```bash
node --test tests/feasibility/release-metadata.test.mjs tests/feasibility/github-e2e-safety.test.mjs tests/feasibility/local-release-lib.test.mjs tests/feasibility/local-release-git.test.mjs tests/feasibility/local-qualify.test.mjs tests/feasibility/package-plugin.test.mjs tests/feasibility/local-release-github.test.mjs tests/feasibility/local-release.test.mjs
```

Expected: PASS on the implementation machine. Windows-specific runner-construction tests execute by injected platform even on POSIX; before first real Windows release, run the same suite natively on Windows as documented in the runbook.

- [ ] **Step 5: Verify forbidden scope did not change**

```bash
git diff --check master...HEAD
git diff --name-only master...HEAD
```

`.github/workflows/github-e2e-live.yml` and `.github/workflows/release.yml` must be unchanged.

- [ ] **Step 6: Commit docs**

```bash
git add docs/releasing.md docs/github-e2e.md .env.github-e2e.example
git commit -m "docs: document official local release workflow"
```

- [ ] **Step 7: Final pre-merge review checkpoint**

Record:

```text
- final branch HEAD SHA
- exact Node/pnpm versions used
- verification commands and exit status
- confirmation no real stable tag/release was created by tests
- confirmation Actions workflow files are unchanged
- rollout remaining: merge -> qualify exact final master -> release exact qualified version
```

Review all 17 acceptance criteria in the spec before merge or real publication.
