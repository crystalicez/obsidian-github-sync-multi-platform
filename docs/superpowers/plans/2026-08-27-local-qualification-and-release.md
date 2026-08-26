# Local Qualification and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a safe, exact-SHA local qualification and stable-release workflow with remote qualification receipts, destructive-E2E isolation, deterministic packaging, explicit draft publication, and byte-level release verification.

**Architecture:** Keep orchestration thin and split reusable concerns into focused modules: release metadata/toolchain validation, E2E environment safety, Git/ref/receipt handling, deterministic packaging, and GitHub release-state inspection. `qualify:local` publishes one annotated qualification object only after every gate and cleanup check; `release:local` claims the stable tag, creates an explicit draft, verifies exact assets, rechecks exact evidence/master state, publishes the draft, and post-verifies it.

**Tech Stack:** Node.js v22.11.0, ESM `.mjs`, pnpm 9.12.3 through Corepack, Node built-in `node:test`, Git CLI, GitHub CLI, `fflate@0.8.3`, existing feasibility test tier.

**Spec:** `docs/superpowers/specs/2026-08-26-local-qualification-and-release-design.md`

## Global Constraints

- Canonical repository is exactly `crystalicez/obsidian-github-sync-multi-platform`.
- Official local qualification runs only on clean `master` where local `HEAD` equals remote `refs/heads/master`.
- Running Node must equal `.node-version` exactly: `v22.11.0`.
- Running pnpm must equal the version in `package.json#packageManager`: `9.12.3`.
- Qualification authority is a remote annotated tag object at `refs/tags/qualification/local/v1/<version>/<sha>` whose object directly targets the exact commit.
- Stable release tags remain lightweight canonical `x.y.z` tags and are never force-updated.
- Destructive E2E must never target the source repository and official qualification must use a unique run-specific E2E branch.
- A remote lookup error is never equivalent to absence; only proven missing refs or a successful complete release-list lookup with no match count as absent.
- Stable publication is `stable-tag claim -> explicit draft -> exact asset verification -> final recheck -> explicit publish -> post-verification`.
- Never auto-delete, auto-clobber, force-update, or silently resume partial stable publication state.
- Release assets are exactly `main.js`, `manifest.json`, `styles.css`, and `obsidian-github-sync-multi-platform-v<version>.zip`.
- ZIP root is exactly `obsidian-github-sync-multi-platform/`; entry separators are `/` on every OS.
- `manifest.json` and `styles.css` release bytes use LF checkout policy; avoid broad repository-wide line-ending rewrites.
- Process-heavy release tests live under `tests/feasibility/`; do not create a new `tests/release/` tier.
- `.github/workflows/github-e2e-live.yml` and `.github/workflows/release.yml` retain their current authority and behavior.

---

## File Map

**Create**

- `scripts/release-metadata.mjs` — canonical stable-version parsing, metadata validation, and committed toolchain declarations.
- `scripts/validate-release-metadata.mjs` — small CLI wrapper for metadata-only validation.
- `scripts/github-e2e-env.mjs` — `.env.github-e2e` parsing, target safety, and unique qualification branch generation.
- `scripts/local-release-lib.mjs` — qualification receipt schema/constants plus shared command-result and artifact helpers that do not perform orchestration.
- `scripts/local-release-git.mjs` — remote Git queries, clean/master checks, annotated-tag object creation/inspection, and no-force stable-tag claim.
- `scripts/local-release-github.mjs` — complete GitHub release-state lookup, draft/publish commands, and asset-byte verification.
- `scripts/local-qualify.mjs` — qualification orchestration only.
- `scripts/package-plugin.mjs` — deterministic plugin ZIP and local SHA-256 artifact manifest.
- `scripts/local-release.mjs` — stable publication state machine only.
- `.gitattributes` — targeted LF policy for direct-upload text assets.
- `tests/feasibility/release-metadata.test.mjs`
- `tests/feasibility/github-e2e-safety.test.mjs`
- `tests/feasibility/local-release-lib.test.mjs`
- `tests/feasibility/local-release-git.test.mjs`
- `tests/feasibility/local-qualify.test.mjs`
- `tests/feasibility/package-plugin.test.mjs`
- `tests/feasibility/local-release-github.test.mjs`
- `tests/feasibility/local-release.test.mjs`

**Modify**

- `scripts/validate-package.mjs` — reuse metadata validation while preserving built-artifact and secret/lockfile checks.
- `scripts/run-github-e2e.mjs` — reuse the shared E2E configuration/safety helper before destructive execution.
- `package.json` — add `qualify:local`, `release:local`, `validate:metadata`, and exact `fflate` development dependency.
- `pnpm-lock.yaml` — lock `fflate@0.8.3`.
- `docs/releasing.md` — document the official local state machine and inspection-only recovery boundary.
- `docs/github-e2e.md` — document source-repo rejection and unique official qualification branches.
- `.env.github-e2e.example` — clarify that its branch is for manual E2E; official qualification overrides it.

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
- Produces: `compareStableVersions(a, b) -> -1 | 0 | 1`
- Produces: `readReleaseMetadata(cwd) -> Promise<{packageJson,manifest,versions,nodeVersion,pnpmVersion}>`
- Produces: `validateReleaseMetadata(metadata, {requestedVersion?}) -> {version,minAppVersion,nodeVersion,pnpmVersion}`
- Consumed later by: qualification preflight, release preflight, stable-tag ordering, and `validate-package.mjs`.

- [ ] **Step 1: Write failing tests for canonical version parsing and exact comparison**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  compareStableVersions,
  parseStableVersion,
  validateReleaseMetadata,
} from "../../scripts/release-metadata.mjs";

test("stable versions reject leading zeros and prerelease syntax", () => {
  assert.deepEqual(parseStableVersion("1.0.8"), [1n, 0n, 8n]);
  assert.equal(parseStableVersion("01.0.8"), null);
  assert.equal(parseStableVersion("1.0.8-beta.1"), null);
  assert.equal(parseStableVersion("v1.0.8"), null);
});

test("stable comparison remains exact beyond Number.MAX_SAFE_INTEGER", () => {
  assert.equal(compareStableVersions("9007199254740993.0.0", "9007199254740992.999.999"), 1);
});

test("metadata validation returns committed toolchain declarations", () => {
  const result = validateReleaseMetadata({
    packageJson: {
      version: "1.0.8",
      packageManager: "pnpm@9.12.3+sha512.deadbeef",
    },
    manifest: { id: "encrypted-github-sync-multi-platform", version: "1.0.8", minAppVersion: "1.11.4" },
    versions: { "1.0.8": "1.11.4" },
    nodeVersion: "v22.11.0",
  });
  assert.equal(result.version, "1.0.8");
  assert.equal(result.nodeVersion, "v22.11.0");
  assert.equal(result.pnpmVersion, "9.12.3");
});
```

- [ ] **Step 2: Run the focused test and prove it fails before implementation**

Run:

```bash
corepack pnpm test:feasibility -- --filter=release-metadata
```

If the existing runner does not forward the trailing filter syntax, run the exact test directly instead:

```bash
node --test tests/feasibility/release-metadata.test.mjs
```

Expected: FAIL because `scripts/release-metadata.mjs` does not exist.

- [ ] **Step 3: Implement the pure metadata module**

Use exact component parsing rather than `Number`:

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

`readReleaseMetadata(cwd)` reads `package.json`, `manifest.json`, `versions.json`, and `.node-version`. `validateReleaseMetadata` must reject mismatched package/manifest versions, malformed stable versions, missing `versions[version]`, mismatched `minAppVersion`, missing plugin id, and an invalid package-manager declaration.

- [ ] **Step 4: Add the metadata CLI and refactor package validation without weakening artifact checks**

`scripts/validate-release-metadata.mjs`:

```js
import { readReleaseMetadata, validateReleaseMetadata } from "./release-metadata.mjs";

const result = validateReleaseMetadata(await readReleaseMetadata(process.cwd()));
console.log(`Validated release metadata for v${result.version}`);
```

In `scripts/validate-package.mjs`, replace its duplicated package/manifest/versions semver checks with `readReleaseMetadata` + `validateReleaseMetadata`, but keep the existing `main.js`/`manifest.json`/`styles.css` existence checks, lockfile tracking checks, and secret-file checks intact.

- [ ] **Step 5: Run focused and existing package-validation tests**

```bash
node --test tests/feasibility/release-metadata.test.mjs tests/feasibility/validate-package.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit the independently testable metadata layer**

```bash
git add scripts/release-metadata.mjs scripts/validate-release-metadata.mjs scripts/validate-package.mjs tests/feasibility/release-metadata.test.mjs tests/feasibility/validate-package.test.mjs
git commit -m "feat: add release metadata validation"
```

---

### Task 2: Shared E2E Environment Safety and Qualification Branch Isolation

**Files:**
- Create: `scripts/github-e2e-env.mjs`
- Modify: `scripts/run-github-e2e.mjs`
- Test: `tests/feasibility/github-e2e-safety.test.mjs`

**Interfaces:**
- Produces: `parseEnvLine(line)` and `loadGitHubE2EEnv({cwd, env, envFile})`.
- Produces: `validateGitHubE2EConfig({owner,repo,branch,token,sourceRepo})`.
- Produces: `qualificationE2EBranch(sha, randomId) -> string`.
- Consumed later by: `local-qualify.mjs` and the existing real-E2E runner.

- [ ] **Step 1: Write failing safety tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  qualificationE2EBranch,
  validateGitHubE2EConfig,
} from "../../scripts/github-e2e-env.mjs";

const sourceRepo = "crystalicez/obsidian-github-sync-multi-platform";

test("destructive E2E rejects the source repository", () => {
  assert.throws(() => validateGitHubE2EConfig({
    owner: "Crystalicez",
    repo: "obsidian-github-sync-multi-platform",
    branch: "e2e-destructive",
    token: "secret",
    sourceRepo,
  }), /source repository/i);
});

test("qualification branches are run-specific and namespaced", () => {
  const a = qualificationE2EBranch("a".repeat(40), "run-a");
  const b = qualificationE2EBranch("a".repeat(40), "run-b");
  assert.equal(a, "obsidian-sync-e2e/local-aaaaaaaaaaaa-run-a");
  assert.notEqual(a, b);
});
```

Also add cases for protected names (`master`, `release`), missing credentials, and case-insensitive owner/repo equality.

- [ ] **Step 2: Run the focused test and prove failure**

```bash
node --test tests/feasibility/github-e2e-safety.test.mjs
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Extract env parsing and implement safety helpers**

The validation contract must be explicit:

```js
const FORBIDDEN_BRANCHES = new Set(["main", "master", "production", "prod", "release", "stable"]);

export function validateGitHubE2EConfig({ owner, repo, branch, token, sourceRepo }) {
  if (!owner || !repo || !branch || !token) throw new Error("Missing required GitHub E2E configuration");
  if (`${owner}/${repo}`.toLowerCase() === sourceRepo.toLowerCase()) {
    throw new Error("Refusing destructive GitHub E2E against the source repository");
  }
  if (FORBIDDEN_BRANCHES.has(branch.toLowerCase())) {
    throw new Error(`Refusing destructive GitHub E2E branch: ${branch}`);
  }
  return { owner, repo, branch, token };
}

export function qualificationE2EBranch(sha, randomId) {
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("Qualification SHA must be 40 lowercase hex characters");
  if (!/^[A-Za-z0-9_-]+$/u.test(randomId)) throw new Error("Unsafe qualification branch run id");
  return `obsidian-sync-e2e/local-${sha.slice(0, 12)}-${randomId}`;
}
```

Move the current `.env.github-e2e` parsing logic out of `run-github-e2e.mjs` without changing shell-env-wins semantics.

- [ ] **Step 4: Update the existing runner to reject source-repository targets before destructive tests**

`run-github-e2e.mjs` should resolve the current source repository from Git `origin` using the repository-normalization helper introduced in Task 3 once available. Until Task 3 lands, keep one small internal normalization helper and replace it with the shared helper during Task 3. The destructive path must invoke `validateGitHubE2EConfig` before bundling/running live tests; `--compile-only` remains credential-free.

Do not alter the three E2E scenario files or their runtime semantics.

- [ ] **Step 5: Run safety and compile-only regression tests**

```bash
node --test tests/feasibility/github-e2e-safety.test.mjs tests/feasibility/github-e2e-compile-cli.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit E2E safety independently**

```bash
git add scripts/github-e2e-env.mjs scripts/run-github-e2e.mjs tests/feasibility/github-e2e-safety.test.mjs
git commit -m "fix: harden destructive github e2e configuration"
```

---

### Task 3: Qualification Receipt and Remote Git Object Primitives

**Files:**
- Create: `scripts/local-release-lib.mjs`
- Create: `scripts/local-release-git.mjs`
- Test: `tests/feasibility/local-release-lib.test.mjs`
- Test: `tests/feasibility/local-release-git.test.mjs`
- Modify: `scripts/run-github-e2e.mjs` to consume the final shared repository normalizer.

**Interfaces:**
- Produces: `CANONICAL_REPOSITORY`, `QUALIFICATION_GATES`, `qualificationTagName(version, sha)`.
- Produces: `normalizeCanonicalGitHubRemote(url) -> owner/repo` or throws.
- Produces: `createQualificationReceipt(input) -> object` and `validateQualificationReceipt(receipt, expected) -> object`.
- Produces: `runCommand(command,args,{cwd,env,encoding}) -> {status,stdout,stderr}`.
- Produces: `lookupRemoteRef({runner,cwd,remote,ref}) -> {kind:"present",objectSha}|{kind:"absent"}` and throws on unknown/error.
- Produces: `inspectTagObject({runner,cwd,objectSha}) -> {targetSha,targetType,tagName,message}`.
- Produces: `createAnnotatedTagObject({runner,cwd,tagName,targetSha,message}) -> objectSha` using `git mktag`.
- Produces: `claimStableTag({runner,cwd,remote,version,sha}) -> {kind:"created",sha}|{kind:"ambiguous"}`; existing-ref rejection throws.
- Consumed later by: `local-qualify.mjs` and `local-release.mjs`.

- [ ] **Step 1: Write receipt tests including tag-object identity-sensitive fields**

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

test("qualification receipt uses the exact v1 authority contract", () => {
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
    sha,
    version: "1.0.8",
    nodeVersion: "v22.11.0",
    pnpmVersion: "9.12.3",
  }));
});

test("receipt rejects reordered, duplicate, missing, or extra gates", () => {
  const base = createQualificationReceipt({
    sha,
    version: "1.0.8",
    qualifiedAt: "2026-08-27T00:00:00.000Z",
    durationMs: 1,
    platform: "linux-x64",
    nodeVersion: "v22.11.0",
    pnpmVersion: "9.12.3",
  });
  assert.throws(() => validateQualificationReceipt({ ...base, gates: [...base.gates].reverse() }, {
    sha, version: "1.0.8", nodeVersion: "v22.11.0", pnpmVersion: "9.12.3",
  }), /gates/i);
});
```

- [ ] **Step 2: Write real temporary-Git tests before Git helper implementation**

Create a temp repository, configure a test identity, make one commit, run the intended `git mktag` flow, then assert:

```js
const inspected = inspectTagObject({ runner: runCommand, cwd, objectSha });
assert.equal(inspected.targetType, "commit");
assert.equal(inspected.targetSha, commitSha);
assert.equal(inspected.tagName, expectedTagName);
```

Add a nested-tag fixture and assert qualification verification rejects `targetType === "tag"`. Add a bare temp `origin` and prove a no-force second push to the same stable ref is rejected.

- [ ] **Step 3: Run both tests and prove failure**

```bash
node --test tests/feasibility/local-release-lib.test.mjs tests/feasibility/local-release-git.test.mjs
```

Expected: FAIL because helper modules do not exist.

- [ ] **Step 4: Implement strict remote normalization and receipt validation**

Accept only canonical GitHub forms that resolve to the same owner/repo, including:

```text
https://github.com/crystalicez/obsidian-github-sync-multi-platform.git
git@github.com:crystalicez/obsidian-github-sync-multi-platform.git
ssh://git@github.com/crystalicez/obsidian-github-sync-multi-platform.git
```

Reject other hosts, extra path segments, embedded HTTPS credentials, and another owner/repo. Error text must print only normalized/sanitized values.

Define the gate constant exactly:

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

- [ ] **Step 5: Implement Git tri-state reads and tag-object helpers**

`lookupRemoteRef` must use a successful `git ls-remote` as the boundary:

```js
const result = runner("git", ["ls-remote", remote, ref], { cwd, encoding: "utf8" });
if (result.status !== 0) throw new Error(`Remote ref lookup failed for ${ref}`);
const lines = result.stdout.trim() ? result.stdout.trim().split(/\r?\n/u) : [];
if (lines.length === 0) return { kind: "absent" };
if (lines.length !== 1) throw new Error(`Ambiguous remote ref response for ${ref}`);
return { kind: "present", objectSha: lines[0].split(/\s+/u)[0] };
```

For remote qualification inspection, fetch the observed object into the object database or `FETCH_HEAD`, then inspect that exact observed object ID using `git cat-file`; never read a same-named local tag as authority.

- [ ] **Step 6: Run Git-object and helper tests**

```bash
node --test tests/feasibility/local-release-lib.test.mjs tests/feasibility/local-release-git.test.mjs tests/feasibility/github-e2e-safety.test.mjs
```

Expected: PASS, including the real temporary-Git fixture.

- [ ] **Step 7: Commit the Git/receipt authority layer**

```bash
git add scripts/local-release-lib.mjs scripts/local-release-git.mjs scripts/run-github-e2e.mjs tests/feasibility/local-release-lib.test.mjs tests/feasibility/local-release-git.test.mjs tests/feasibility/github-e2e-safety.test.mjs
git commit -m "feat: add local qualification git authority primitives"
```

---

### Task 4: `qualify:local` Orchestration

**Files:**
- Create: `scripts/local-qualify.mjs`
- Create: `tests/feasibility/local-qualify.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Tasks 1-3 metadata, E2E, receipt, and Git helpers.
- Produces: `qualifyLocal({cwd,runner,now,randomId}) -> Promise<{sha,version,qualificationRef,qualificationTagObjectSha,alreadyQualified}>`.
- Produces public CLI: `pnpm qualify:local`.

- [ ] **Step 1: Write orchestration tests with injected runners**

Use a fake runner/event log so the test can assert ordering without GitHub mutation:

```js
const events = [];
const result = await qualifyLocal({
  cwd: "/repo",
  runner: fakeRunner(events),
  now: () => new Date("2026-08-27T00:00:00.000Z"),
  randomId: () => "unit-test-run",
});

assert.deepEqual(events.filter(event => event.kind === "gate").map(event => event.name), [
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

Add separate tests proving:

- wrong Node/pnpm version fails before any expensive gate,
- missing Git tagger identity fails before gates,
- existing valid remote receipt returns `alreadyQualified: true` without gates,
- existing invalid receipt fails,
- build occurs before package validation,
- static env branch is replaced with `obsidian-sync-e2e/local-...`,
- source-repository E2E config fails before live E2E,
- live E2E success followed by branch-still-present fails and publishes no receipt,
- remote master movement after gates prevents receipt publication,
- push transport failure reconciles only when the remote ref object ID exactly equals this invocation's tag object ID.

- [ ] **Step 2: Run the orchestration test and prove failure**

```bash
node --test tests/feasibility/local-qualify.test.mjs
```

Expected: FAIL because `local-qualify.mjs` does not exist.

- [ ] **Step 3: Implement preflight and exact gate runner**

Use an explicit gate table instead of ad-hoc calls:

```js
const GATES = [
  ["install-frozen", "corepack", ["pnpm", "install", "--frozen-lockfile"]],
  ["build", "corepack", ["pnpm", "build"]],
  ["package-validation", "corepack", ["pnpm", "validate:package"]],
  ["fast-tests", "corepack", ["pnpm", "test"]],
  ["repeat-tests", "corepack", ["pnpm", "test:repeat"]],
  ["recovery-tests", "corepack", ["pnpm", "test:recovery"]],
  ["resource-tests", "corepack", ["pnpm", "test:resource"]],
  ["feasibility-tests", "corepack", ["pnpm", "test:feasibility"]],
  ["github-e2e-compile", "corepack", ["pnpm", "test:github-e2e:compile"]],
];
```

Run metadata validation directly before this table and count it as the first receipt gate. Run live E2E separately with a child `env` whose `GITHUB_E2E_BRANCH` is the generated unique branch.

On Windows, route the `corepack` invocation through a platform-aware helper rather than assuming a POSIX executable name. The helper must keep all dynamic values as argv/env data, never interpolate them into a shell command string.

- [ ] **Step 4: Verify E2E cleanup explicitly before receipt creation**

After the live command returns zero, perform a read-only GitHub branch-ref lookup using the same E2E owner/repo/token and require a proven `404`/absence for the unique run branch. A transport error or still-present branch fails qualification.

- [ ] **Step 5: Create/push the annotated receipt only after post-gate revalidation**

Call `createAnnotatedTagObject`, then push its exact object to the exact qualification ref without force. Re-query remote state and apply the spec's exact object-ID reconciliation rules.

- [ ] **Step 6: Add the public package script**

```json
{
  "scripts": {
    "validate:metadata": "node scripts/validate-release-metadata.mjs",
    "qualify:local": "node scripts/local-qualify.mjs"
  }
}
```

Preserve every existing script.

- [ ] **Step 7: Run qualification-focused tests and compile gate**

```bash
node --test tests/feasibility/local-qualify.test.mjs tests/feasibility/local-release-git.test.mjs tests/feasibility/github-e2e-safety.test.mjs
corepack pnpm test:github-e2e:compile
```

Expected: all PASS. No real GitHub mutation occurs in unit/feasibility tests.

- [ ] **Step 8: Commit qualification orchestration**

```bash
git add scripts/local-qualify.mjs tests/feasibility/local-qualify.test.mjs package.json
git commit -m "feat: add exact-sha local qualification command"
```

---

### Task 5: Deterministic Cross-Platform Plugin Packaging

**Files:**
- Create: `scripts/package-plugin.mjs`
- Create: `tests/feasibility/package-plugin.test.mjs`
- Create: `.gitattributes`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `packagePlugin({cwd,version}) -> Promise<{zipPath,assets}>`.
- Produces artifact record: `{name,path,size,sha256}` where `sha256` is lowercase 64-hex without an algorithm prefix.
- Consumed later by: `local-release.mjs` and remote asset verification.

- [ ] **Step 1: Add exact ZIP dependency and targeted line-ending policy**

Use:

```json
{
  "devDependencies": {
    "fflate": "0.8.3"
  }
}
```

Then run:

```bash
corepack pnpm install
```

Expected: `pnpm-lock.yaml` updates and records exactly `fflate@0.8.3`.

Create `.gitattributes` with only:

```gitattributes
/manifest.json text eol=lf
/styles.css text eol=lf
```

- [ ] **Step 2: Write failing deterministic packaging tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { packagePlugin } from "../../scripts/package-plugin.mjs";

test("plugin package has exact repository-rooted paths and repeatable bytes", async () => {
  const first = await packagePlugin({ cwd: fixtureDir, version: "1.0.8" });
  const firstBytes = await readFile(first.zipPath);
  const second = await packagePlugin({ cwd: fixtureDir, version: "1.0.8" });
  const secondBytes = await readFile(second.zipPath);
  assert.deepEqual(secondBytes, firstBytes);

  const entries = unzipSync(firstBytes);
  assert.deepEqual(Object.keys(entries), [
    "obsidian-github-sync-multi-platform/main.js",
    "obsidian-github-sync-multi-platform/manifest.json",
    "obsidian-github-sync-multi-platform/styles.css",
  ]);
});
```

Add assertions that `assets` contains exactly four records, output lives under `.tmp/release/1.0.8/`, unrelated files are excluded, unsafe/mismatched version input is rejected, and each record's size/digest matches local bytes.

- [ ] **Step 3: Run the test and prove failure**

```bash
node --test tests/feasibility/package-plugin.test.mjs
```

Expected: FAIL because the packager does not exist.

- [ ] **Step 4: Implement deterministic packaging with flat POSIX keys**

Core implementation shape:

```js
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";

const RELEASE_ROOT = "obsidian-github-sync-multi-platform";
const SOURCE_NAMES = ["main.js", "manifest.json", "styles.css"];

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const archiveInput = Object.create(null);
for (const name of SOURCE_NAMES) {
  archiveInput[`${RELEASE_ROOT}/${name}`] = [await readFile(path.join(cwd, name)), { level: 9 }];
}
const zipBytes = zipSync(archiveInput, {
  level: 9,
  mtime: new Date(1980, 0, 1, 0, 0, 0),
});
```

Do not use `path.join` for ZIP entry names. Verify determinism test on the implementation environment; if `fflate` timestamp encoding proves timezone-dependent, set per-entry options using the library's supported fixed metadata representation and add a regression that changes `TZ` between child processes before proceeding.

- [ ] **Step 5: Run package tests plus package validation**

```bash
node --test tests/feasibility/package-plugin.test.mjs
corepack pnpm build
corepack pnpm validate:package
```

Expected: PASS.

- [ ] **Step 6: Commit packaging and lockfile changes**

```bash
git add scripts/package-plugin.mjs tests/feasibility/package-plugin.test.mjs .gitattributes package.json pnpm-lock.yaml
git commit -m "feat: add deterministic plugin release packaging"
```

---

### Task 6: GitHub Release-State and Asset Verification Helpers

**Files:**
- Create: `scripts/local-release-github.mjs`
- Create: `tests/feasibility/local-release-github.test.mjs`

**Interfaces:**
- Produces: `readReleaseState({runner,repo,version}) -> {kind:"absent"}|{kind:"present",release}`.
- Produces: release shape `{id,tagName,name,isDraft,isPrerelease,targetCommitish,uploadUrl,assets}`.
- Produces: asset shape `{id,name,size,state,digest,apiUrl}`.
- Produces: `verifyReleaseAssets({release,localArtifacts,fetchAssetBytes}) -> Promise<void>`.
- Produces: `createDraftArgs({repo,version,previousStableTag,assetPaths}) -> string[]`.
- Produces: `publishDraftArgs({repo,version}) -> string[]`.
- Consumed later by: `local-release.mjs`.

- [ ] **Step 1: Write failing release-state tests with complete-list semantics**

Use a fake `gh` runner whose successful response represents all paginated releases:

```js
test("release absence requires a successful complete release-list lookup", () => {
  const state = readReleaseState({
    runner: fakeGh({ status: 0, stdout: JSON.stringify([[{ tag_name: "1.0.6", draft: false }]]) }),
    repo: "crystalicez/obsidian-github-sync-multi-platform",
    version: "1.0.8",
  });
  assert.deepEqual(state, { kind: "absent" });
});

test("release lookup transport errors do not mean absent", () => {
  assert.throws(() => readReleaseState({
    runner: fakeGh({ status: 1, stderr: "network failure" }),
    repo: "crystalicez/obsidian-github-sync-multi-platform",
    version: "1.0.8",
  }), /lookup failed/i);
});
```

Use the semantic equivalent of:

```text
gh api --paginate --slurp repos/crystalicez/obsidian-github-sync-multi-platform/releases?per_page=100
```

because a successful full list can prove both published and draft absence without parsing CLI error strings as 404/not-found.

- [ ] **Step 2: Write failing asset-integrity tests**

Cover exact-set success and rejection of missing, extra, duplicate, wrong-size, wrong-digest, and non-uploaded assets.

For digest fallback:

```js
test("missing GitHub asset digest downloads and hashes the remote bytes", async () => {
  let fetched = false;
  await verifyReleaseAssets({
    release,
    localArtifacts,
    fetchAssetBytes: async asset => {
      fetched = true;
      return localBytesByName.get(asset.name);
    },
  });
  assert.equal(fetched, true);
});
```

- [ ] **Step 3: Run tests and prove failure**

```bash
node --test tests/feasibility/local-release-github.test.mjs
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 4: Implement release lookup and normalized digest handling**

Accept GitHub digest forms only when they parse as `sha256:<64-hex>`; normalize to lowercase raw hex before comparison. If digest is absent, fetch bytes using `gh api` in binary mode through the injected runner and hash in memory. Never use shell redirection and never print token-bearing output.

The exact expected asset names come from `packagePlugin().assets`, not from remote state.

- [ ] **Step 5: Implement explicit draft/publish argv builders**

Draft args must include:

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

Publish args must be exactly the semantic equivalent of:

```js
["release", "edit", version, "--repo", repo, "--draft=false"]
```

There is no `--clobber`, no delete call, and no non-draft `release create` path.

- [ ] **Step 6: Run helper tests**

```bash
node --test tests/feasibility/local-release-github.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit GitHub release inspection helpers**

```bash
git add scripts/local-release-github.mjs tests/feasibility/local-release-github.test.mjs
git commit -m "feat: add verified github release state helpers"
```

---

### Task 7: `release:local` Publication State Machine

**Files:**
- Create: `scripts/local-release.mjs`
- Create: `tests/feasibility/local-release.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: metadata/toolchain, Git authority, qualification receipt, package manifest, and GitHub release helpers from Tasks 1, 3, 5, and 6.
- Produces: `releaseLocal({cwd,version,runner}) -> Promise<{version,sha,qualificationTagObjectSha,releaseUrl}>`.
- Produces public CLI: `pnpm release:local -- <version>`.

- [ ] **Step 1: Write failing state-machine tests before implementation**

Build a fake remote-state model and command event log. Cover at minimum:

```js
test("release publishes only after exact draft asset verification and final evidence recheck", async () => {
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

Add independent tests proving:

- requested version must equal package/manifest metadata,
- requested version must be greater than every remote canonical stable tag,
- qualification tag must be annotated, direct-to-commit, valid, and exact SHA/version,
- a replacement qualification tag object with the same peeled commit is detected before publish,
- stale local qualification refs are ignored,
- pre-existing stable tag fails preflight,
- pre-existing draft or published release fails preflight,
- stable-tag no-force rejection aborts even if another process created the same SHA,
- ambiguous stable-tag push stops instead of proceeding to draft creation,
- draft-create/upload failure never invokes delete/retry/clobber,
- wrong/partial/extra asset state blocks publication,
- remote master movement after draft verification blocks publication and leaves state untouched,
- ambiguous final publish reconciles only when post-read proves exact non-draft/non-prerelease release and matching assets,
- successful CLI publish still requires post-verification.

- [ ] **Step 2: Run the state-machine test and prove failure**

```bash
node --test tests/feasibility/local-release.test.mjs
```

Expected: FAIL because `local-release.mjs` does not exist.

- [ ] **Step 3: Implement preflight and qualification snapshot**

Preflight order must be cheap-to-expensive:

```text
argument/version parse
clean branch/master/origin
metadata + toolchain
remote stable-tag enumeration/monotonicity
requested stable-tag absence
complete GitHub release/draft absence
remote qualification tag fetch/validation
snapshot qualificationTagObjectSha
```

Enumerate remote stable refs from `refs/tags/` with a complete `git ls-remote --tags origin` call, filter names through `parseStableVersion`, and compare with `BigInt` components. Do not use a paginated/limited GitHub tags list.

- [ ] **Step 4: Implement publication-machine gates and packaging**

Run exactly:

```text
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm validate:package
corepack pnpm test
corepack pnpm test:github-e2e:compile
```

Then package and compute the local four-asset manifest. Re-read metadata/clean tree/HEAD/master before the first stable mutation.

- [ ] **Step 5: Implement stable-tag claim with conservative ambiguous handling**

Call the Task 3 no-force tag claim. A positive success must be followed by a remote exact-SHA verification. An explicit existing-ref rejection aborts. A transport-ambiguous result stops for inspection even if the remote tag is observed at the expected SHA, because a lightweight tag has no per-invocation object identity.

Do not continue to draft creation on an ambiguous tag claim.

- [ ] **Step 6: Implement explicit draft creation and exact asset verification**

Call only Task 6's `createDraftArgs` path. On a zero exit, re-read release state and verify assets. On a nonzero/unknown exit, perform read-only inspection and stop; do not retry or delete.

- [ ] **Step 7: Recheck evidence/master/assets immediately before publish**

The final evidence check must require:

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

Then call `verifyReleaseAssets` again using the local manifest.

- [ ] **Step 8: Publish explicitly and reconcile only exact final state**

Invoke `gh release edit ... --draft=false`. Regardless of zero/nonzero exit, final success requires a fresh remote read proving non-draft, non-prerelease, exact stable tag SHA, unchanged qualification object SHA, and exact asset bytes.

On a nonzero publish result, treat an exact proven final state as reconciled success; otherwise fail with inspection commands and no mutation cleanup.

- [ ] **Step 9: Add the public release script**

```json
{
  "scripts": {
    "release:local": "node scripts/local-release.mjs"
  }
}
```

The CLI must require exactly one explicit version argument after pnpm's `--` separator and print phases without secrets.

- [ ] **Step 10: Run publication-focused tests**

```bash
node --test tests/feasibility/local-release.test.mjs tests/feasibility/local-release-github.test.mjs tests/feasibility/local-release-git.test.mjs tests/feasibility/package-plugin.test.mjs
```

Expected: PASS.

- [ ] **Step 11: Commit the state machine**

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
- Verify: all files created/modified by Tasks 1-7.

**Interfaces:**
- Consumes: final CLI behavior.
- Produces: copy-paste local qualification/release runbook and explicit partial-state inspection guidance.

- [ ] **Step 1: Update the local release runbook with exact commands and state transitions**

Add a first-class local path that uses:

```text
corepack pnpm install --frozen-lockfile
pnpm qualify:local
pnpm release:local -- 1.0.8
```

Document prerequisites: clean `master`, exact Node v22.11.0, Corepack/pnpm 9.12.3, Git tagger identity, tag-push auth, GitHub CLI auth, disposable E2E repository, and `.env.github-e2e` values.

Explain the publication states explicitly:

```text
qualified receipt -> stable tag -> draft -> verified assets -> published release
```

State that a pre-existing stable tag/draft from another invocation is inspection-only in v1; the command will not auto-resume/delete it.

- [ ] **Step 2: Update E2E docs/example to distinguish manual and official branch behavior**

In `.env.github-e2e.example`, keep a safe manual branch but add a comment supported by the parser:

```text
# Manual E2E branch. pnpm qualify:local overrides this with a unique run-specific branch.
GITHUB_E2E_BRANCH=e2e-destructive
```

Document that all destructive local E2E now rejects the source repository and official qualification additionally uses `obsidian-sync-e2e/local-<sha12>-<random-id>`.

- [ ] **Step 3: Run the complete deterministic suite required before claiming implementation complete**

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

Do **not** run `pnpm qualify:local` or `pnpm release:local` against real GitHub as part of ordinary implementation tests. The first real qualification is a deliberate rollout step after merge to final `master` with authorized disposable-E2E credentials.

- [ ] **Step 4: Run focused safety regressions one more time**

```bash
node --test \
  tests/feasibility/release-metadata.test.mjs \
  tests/feasibility/github-e2e-safety.test.mjs \
  tests/feasibility/local-release-lib.test.mjs \
  tests/feasibility/local-release-git.test.mjs \
  tests/feasibility/local-qualify.test.mjs \
  tests/feasibility/package-plugin.test.mjs \
  tests/feasibility/local-release-github.test.mjs \
  tests/feasibility/local-release.test.mjs
```

On PowerShell, invoke the same files on one line or through an argv-based Node invocation; the implementation itself must not rely on POSIX continuation syntax.

Expected: PASS.

- [ ] **Step 5: Check the branch diff for forbidden/unintended scope changes**

```bash
git diff --check master...HEAD
git diff --name-only master...HEAD
```

Expected changed implementation scope is limited to the design/plan docs, release/E2E scripts and tests, package metadata/lockfile, `.gitattributes`, `.env.github-e2e.example`, and release/E2E documentation. `.github/workflows/github-e2e-live.yml` and `.github/workflows/release.yml` must not change.

- [ ] **Step 6: Commit documentation and final verification updates**

```bash
git add docs/releasing.md docs/github-e2e.md .env.github-e2e.example
git commit -m "docs: document official local release workflow"
```

- [ ] **Step 7: Final pre-merge review checkpoint**

Review the final branch against all 17 acceptance criteria in the spec. In the review report, explicitly record:

```text
- final branch HEAD SHA
- exact Node/pnpm versions used for deterministic verification
- commands run and exit status
- confirmation that no real stable tag/release was created during tests
- confirmation that Actions workflow files are unchanged
- remaining rollout action: merge -> qualify exact final master -> release exact qualified version
```

No merge or real release occurs until this checkpoint is clean.
