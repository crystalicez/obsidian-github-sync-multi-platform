# Local Qualification and Release V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the audited exact-SHA local qualification/release design with safe destructive-E2E isolation, durable qualification receipts, atomic create-only stable-ref ownership, deterministic cross-platform staging, explicit draft publication, and byte-level remote verification.

**Architecture:** Keep orchestration thin. Separate repository identity, E2E configuration, E2E remote cleanup, Git-object authority, packaging, and GitHub publication helpers so each safety boundary has focused tests. `qualify:local` creates one remote annotated receipt only after deterministic/live gates and out-of-band E2E cleanup; `release:local` snapshots that exact tag object, stages exact bytes, atomically creates the lightweight stable ref with GitHub's create-reference endpoint, stages an explicit draft, verifies remote bytes, publishes, and post-verifies.

**Tech Stack:** Node.js v22.11.0, ESM `.mjs`, existing CommonJS `scripts/update-version.js`, pnpm 9.12.3 through Corepack, Node `node:test`, Git CLI, GitHub CLI pinned to `github.com`, Node 22 global `fetch`, `fflate@0.8.3`, existing `tests/feasibility/` tier.

**Spec:** `docs/superpowers/specs/2026-08-27-local-qualification-and-release-design.md`

## Global Constraints

- Canonical source repository: `crystalicez/obsidian-github-sync-multi-platform`.
- Stable syntax remains repository-compatible `^\d+\.\d+\.\d+$`; no new strict-SemVer policy.
- Numeric stable ordering uses exact `BigInt` components.
- Official qualify/release require exactly one effective origin fetch URL and one effective origin push URL; both normalize to the canonical repository.
- Manual live E2E does **not** require canonical origin; it rejects destructive targeting of both current-origin repo and canonical source repo.
- Qualification authority is an exact remote annotated tag object at `refs/tags/qualification/local/v1/<version>/<sha>` directly targeting the exact commit.
- Qualification validation snapshots/rechecks remote **tag-object SHA**, not only peeled commit.
- Official local qualification uses unique E2E branch `obsidian-sync-e2e/local-<sha12>-<run-id>` and bounded out-of-band cleanup after every returned live run.
- Stable-ref ownership uses GitHub REST create-reference, not ordinary Git push.
- Stable publication never auto-deletes/clobbers/force-updates or implicitly resumes prior partial state.
- Static release assets `manifest.json` and `styles.css` are staged from exact `HEAD` blobs; `main.js` is staged from the current build output.
- No `.gitattributes` change is required for release correctness.
- Release assets are exactly `main.js`, `manifest.json`, `styles.css`, and `obsidian-github-sync-multi-platform-v<version>.zip`.
- ZIP file entries are exactly repository-rooted forward-slash paths in `main.js`, `manifest.json`, `styles.css` order.
- All GitHub CLI operations are pinned to `github.com` and explicit canonical repo context.
- Remote lookup failure is never interpreted as absence.
- `.github/workflows/github-e2e-live.yml` and `.github/workflows/release.yml` are not modified.
- Incidental Actions runs caused by existing `on: push:` are non-authoritative and not awaited.

---

## File Map

### Create

- `scripts/release-metadata.mjs` — stable-triple parsing/comparison and package/manifest/versions/toolchain metadata validation.
- `scripts/validate-release-metadata.mjs` — metadata-only CLI.
- `scripts/github-repo.mjs` — safe GitHub remote parsing plus official fetch/push origin validation.
- `scripts/github-e2e-env.mjs` — existing env-file semantics, destructive target checks, unique official branch naming.
- `scripts/github-e2e-remote.mjs` — target-repository/default-branch preflight and bounded branch cleanup.
- `scripts/local-release-lib.mjs` — receipt schema/constants, deterministic receipt serialization, process/gate runner.
- `scripts/local-release-git.mjs` — clean/master/ref/object/blob Git authority helpers.
- `scripts/local-release-github.mjs` — GitHub CLI host-pinned auth/state/create-ref/draft/publish/asset helpers.
- `scripts/local-qualify.mjs` — qualification orchestration.
- `scripts/package-plugin.mjs` — deterministic staging, ZIP, local artifact manifest.
- `scripts/local-release.mjs` — stable publication state machine.
- `tests/feasibility/release-metadata.test.mjs`
- `tests/feasibility/github-e2e-safety.test.mjs`
- `tests/feasibility/github-e2e-remote.test.mjs`
- `tests/feasibility/local-release-lib.test.mjs`
- `tests/feasibility/local-release-git.test.mjs`
- `tests/feasibility/local-qualify.test.mjs`
- `tests/feasibility/package-plugin.test.mjs`
- `tests/feasibility/local-release-github.test.mjs`
- `tests/feasibility/local-release.test.mjs`

### Modify

- `scripts/update-version.js` — preserve syntax, replace imprecise numeric comparison/bumping with exact component arithmetic.
- `scripts/validate-package.mjs` — reuse metadata validator while retaining artifact/lock/secret checks.
- `scripts/run-github-e2e.mjs` — reuse env/source-target/remote-default-branch preflight without requiring canonical origin.
- `package.json` — add `validate:metadata`, `qualify:local`, `release:local`, exact `fflate` dev dependency.
- `pnpm-lock.yaml` — lock `fflate@0.8.3`.
- `docs/releasing.md`
- `docs/github-e2e.md`
- `.env.github-e2e.example`

---

# Task 1: Repository-Compatible Version and Metadata Authority

**Files:**
- Create: `scripts/release-metadata.mjs`
- Create: `scripts/validate-release-metadata.mjs`
- Modify: `scripts/update-version.js`
- Modify: `scripts/validate-package.mjs`
- Create: `tests/feasibility/release-metadata.test.mjs`
- Modify: `tests/feasibility/validate-package.test.mjs`

**Interfaces:**
- `parseStableTriple(value) -> [bigint,bigint,bigint] | null`
- `compareStableTriples(a,b) -> -1 | 0 | 1`
- `readReleaseMetadata(cwd) -> Promise<{packageJson,manifest,versions,nodeVersion,pnpmVersion}>`
- `validateReleaseMetadata(metadata,{requestedVersion?}) -> {version,minAppVersion,nodeVersion,pnpmVersion}`

- [ ] **Step 1: Write failing shared metadata/version tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  compareStableTriples,
  parseStableTriple,
  validateReleaseMetadata,
} from "../../scripts/release-metadata.mjs";

test("stable syntax preserves the repository's existing digits.digits.digits contract", () => {
  assert.deepEqual(parseStableTriple("1.0.8"), [1n, 0n, 8n]);
  assert.deepEqual(parseStableTriple("01.0.8"), [1n, 0n, 8n]);
  assert.equal(parseStableTriple("v1.0.8"), null);
  assert.equal(parseStableTriple("1.0.8-beta.1"), null);
});

test("stable comparison is exact beyond Number.MAX_SAFE_INTEGER", () => {
  assert.equal(compareStableTriples("9007199254740993.0.0", "9007199254740992.999.999"), 1);
});

test("metadata exposes exact committed toolchain versions", () => {
  const result = validateReleaseMetadata({
    packageJson: { version: "1.0.8", packageManager: "pnpm@9.12.3+sha512.deadbeef" },
    manifest: { id: "encrypted-github-sync-multi-platform", version: "1.0.8", minAppVersion: "1.11.4" },
    versions: { "1.0.8": "1.11.4" },
    nodeVersion: "v22.11.0",
  });
  assert.equal(result.pnpmVersion, "9.12.3");
  assert.equal(result.nodeVersion, "v22.11.0");
});
```

Also test package/manifest mismatch, missing version mapping, minAppVersion mismatch, invalid packageManager, requested-version mismatch, empty plugin id.

- [ ] **Step 2: Prove shared tests fail**

```bash
node --test tests/feasibility/release-metadata.test.mjs
```

Expected: FAIL because `scripts/release-metadata.mjs` does not exist.

- [ ] **Step 3: Implement stable parsing/comparison and metadata validation**

```js
const STABLE_TRIPLE = /^\d+\.\d+\.\d+$/u;

export function parseStableTriple(value) {
  if (!STABLE_TRIPLE.test(value ?? "")) return null;
  return value.split(".").map(part => BigInt(part));
}

export function compareStableTriples(a, b) {
  const left = parseStableTriple(a);
  const right = parseStableTriple(b);
  if (!left || !right) throw new Error(`Invalid stable triple: ${a}, ${b}`);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] < right[i]) return -1;
    if (left[i] > right[i]) return 1;
  }
  return 0;
}
```

`readReleaseMetadata` trims `.node-version` and extracts pnpm version from `pnpm@<version>+...`.

- [ ] **Step 4: Add metadata-only CLI**

```js
import { readReleaseMetadata, validateReleaseMetadata } from "./release-metadata.mjs";

const result = validateReleaseMetadata(await readReleaseMetadata(process.cwd()));
console.log(`Validated release metadata for v${result.version}`);
```

- [ ] **Step 5: Refactor `validate-package.mjs` without weakening existing checks**

Keep its current checks for generated `main.js`, `manifest.json`, `styles.css`, tracked `pnpm-lock.yaml`, alternate lockfiles, tracked secrets, and ignored local secret files. Replace duplicated metadata comparison with the new shared validator.

- [ ] **Step 6: Add an update-version parity fixture before changing the helper**

In `release-metadata.test.mjs`, create a temp package/manifest/versions workspace and execute the real `scripts/update-version.js` with a huge exact target:

```js
const target = "9007199254740993.0.0";
const result = spawnSync(process.execPath, [updateVersionScript, target], { cwd, encoding: "utf8" });
assert.equal(result.status, 0, result.stderr || result.stdout);
assert.equal(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).version, target);
```

Also assert `v1.2.3`/prerelease targets remain rejected and leading-zero stable triples remain accepted as they are today.

- [ ] **Step 7: Change `update-version.js` to BigInt component arithmetic**

Keep its CommonJS shape and existing accepted syntax. Replace `.map(Number)` comparison/bumping with BigInt component parsing and `+ 1n`. Convert components back to strings when writing versions.

- [ ] **Step 8: Run Task 1 tests**

```bash
node --test tests/feasibility/release-metadata.test.mjs tests/feasibility/validate-package.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add scripts/release-metadata.mjs scripts/validate-release-metadata.mjs scripts/update-version.js scripts/validate-package.mjs tests/feasibility/release-metadata.test.mjs tests/feasibility/validate-package.test.mjs
git commit -m "feat: unify exact release metadata validation"
```

---

# Task 2: GitHub Origin Identity and Local E2E Configuration Safety

**Files:**
- Create: `scripts/github-repo.mjs`
- Create: `scripts/github-e2e-env.mjs`
- Create: `tests/feasibility/github-e2e-safety.test.mjs`

**Interfaces:**
- `CANONICAL_REPOSITORY = "crystalicez/obsidian-github-sync-multi-platform"`
- `parseGitHubRemote(raw) -> "owner/repo"`
- `readOriginFetchRepository({runner,cwd}) -> string`
- `requireCanonicalOriginEndpoints({runner,cwd}) -> {fetchRepository,pushRepository}`
- `parseEnvLine(line)`
- `loadGitHubE2EEnv({cwd,env,envFile}) -> object`
- `validateGitHubE2EConfig({owner,repo,branch,token,currentSourceRepo}) -> config`
- `qualificationE2EBranch(sha,runId) -> string`

- [ ] **Step 1: Write failing remote parser/origin tests**

```js
test("supported github remotes normalize to owner/repo", () => {
  assert.equal(parseGitHubRemote("https://github.com/crystalicez/obsidian-github-sync-multi-platform.git"), CANONICAL_REPOSITORY);
  assert.equal(parseGitHubRemote("git@github.com:crystalicez/obsidian-github-sync-multi-platform.git"), CANONICAL_REPOSITORY);
  assert.equal(parseGitHubRemote("ssh://git@github.com/crystalicez/obsidian-github-sync-multi-platform.git"), CANONICAL_REPOSITORY);
});

test("official origin rejects divergent pushurl", () => {
  const runner = fakeGit({
    fetchUrls: ["https://github.com/crystalicez/obsidian-github-sync-multi-platform.git"],
    pushUrls: ["git@github.com:someone-else/other.git"],
  });
  assert.throws(() => requireCanonicalOriginEndpoints({ runner, cwd: "/repo" }), /push/i);
});
```

Also cover credentials in HTTPS URL, lookalike host, port variation, extra path, multiple fetch URLs, multiple push URLs, and secret-safe errors.

- [ ] **Step 2: Write failing manual E2E source-target tests**

```js
test("manual E2E may run from a fork but cannot target the fork itself", () => {
  assert.throws(() => validateGitHubE2EConfig({
    owner: "fork-owner",
    repo: "obsidian-github-sync-multi-platform",
    branch: "e2e-destructive",
    token: "secret",
    currentSourceRepo: "fork-owner/obsidian-github-sync-multi-platform",
  }), /source repository/i);
});

test("manual E2E from a fork also rejects canonical source target", () => {
  assert.throws(() => validateGitHubE2EConfig({
    owner: "crystalicez",
    repo: "obsidian-github-sync-multi-platform",
    branch: "e2e-destructive",
    token: "secret",
    currentSourceRepo: "fork-owner/obsidian-github-sync-multi-platform",
  }), /source repository/i);
});
```

Also test protected branch names, missing config, case-insensitive equality, shell-env-wins parsing, unique branch validation.

- [ ] **Step 3: Prove tests fail**

```bash
node --test tests/feasibility/github-e2e-safety.test.mjs
```

Expected: FAIL because modules do not exist.

- [ ] **Step 4: Implement safe parsing and official fetch/push endpoint validation**

`requireCanonicalOriginEndpoints` executes exactly:

```text
git remote get-url --all origin
git remote get-url --push --all origin
```

Require exactly one non-empty URL from each and normalize both to `CANONICAL_REPOSITORY`. Never echo raw credential-bearing URLs.

`readOriginFetchRepository` is less strict: exactly one GitHub fetch URL, any owner/repo, used only for destructive manual E2E source detection.

- [ ] **Step 5: Move the existing `.env.github-e2e` parser without changing precedence**

Shell/process env wins over file values. Explicit missing `GITHUB_E2E_ENV_FILE` remains an error. Do not print token values.

- [ ] **Step 6: Implement unique qualification branch naming**

```js
export function qualificationE2EBranch(sha, runId) {
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("Expected full lowercase commit SHA");
  if (!/^[A-Za-z0-9_-]{6,64}$/u.test(runId)) throw new Error("Unsafe qualification run id");
  return `obsidian-sync-e2e/local-${sha.slice(0, 12)}-${runId}`;
}
```

- [ ] **Step 7: Run Task 2 tests and commit**

```bash
node --test tests/feasibility/github-e2e-safety.test.mjs
git add scripts/github-repo.mjs scripts/github-e2e-env.mjs tests/feasibility/github-e2e-safety.test.mjs
git commit -m "feat: add github origin and e2e safety validation"
```

---

# Task 3: E2E Remote Preflight and Out-of-Band Cleanup

**Files:**
- Create: `scripts/github-e2e-remote.mjs`
- Modify: `scripts/run-github-e2e.mjs`
- Create: `tests/feasibility/github-e2e-remote.test.mjs`
- Modify: `tests/feasibility/github-e2e-safety.test.mjs`

**Interfaces:**
- `readE2ERepository({fetchImpl,owner,repo,token}) -> Promise<{defaultBranch}>`
- `readE2EBranch({fetchImpl,owner,repo,branch,token}) -> Promise<{kind:"absent"}|{kind:"present",sha}>`
- `cleanupE2EBranch({fetchImpl,owner,repo,branch,token,sleep,maxAttempts=3}) -> Promise<void>`
- `preflightE2ERemote({fetchImpl,config}) -> Promise<{defaultBranch}>`

- [ ] **Step 1: Write failing repository/default-branch tests**

```js
test("remote preflight rejects actual default branch before mutation", async () => {
  const fetchImpl = fakeFetch([
    response(200, { default_branch: "trunk" }),
  ]);
  await assert.rejects(() => preflightE2ERemote({
    fetchImpl,
    config: { owner: "test", repo: "repo", branch: "trunk", token: "secret" },
  }), /default branch/i);
});
```

Cover repository 401/403/404/429/5xx, malformed JSON/default_branch, safe non-default branch success.

- [ ] **Step 2: Write failing cleanup state-machine tests**

```js
test("cleanup deletes a present unique branch and verifies absence", async () => {
  const fetchImpl = fakeFetch([
    response(200, { object: { sha: "a".repeat(40) } }),
    response(204),
    response(404),
  ]);
  await cleanupE2EBranch({
    fetchImpl, owner: "test", repo: "repo", branch: "obsidian-sync-e2e/local-abc-run", token: "secret",
    sleep: async () => {},
  });
});
```

Add already-absent success; failed delete then successful retry; persistent branch; auth/network unknown; path encoding for `/` branch segments.

- [ ] **Step 3: Prove failure**

```bash
node --test tests/feasibility/github-e2e-remote.test.mjs
```

Expected: FAIL because module does not exist.

- [ ] **Step 4: Implement authenticated direct GitHub REST helper**

Use Node 22 `fetch` with fixed headers:

```js
{
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
}
```

Do not include response bodies containing secrets in user-facing errors.

Cleanup follows `GET -> optional DELETE -> GET verify`, bounded to three attempts with bounded injected sleeps.

- [ ] **Step 5: Wire live runner preflight without requiring canonical origin**

In live (not compile-only) `run-github-e2e.mjs`:

1. `readOriginFetchRepository`,
2. load env,
3. `validateGitHubE2EConfig`,
4. `preflightE2ERemote`,
5. only then bundle/run live tests.

`--compile-only` must continue to work outside a Git repo and without credentials.

Do **not** add out-of-band cleanup to the generic runner; official qualifier owns that extra lifecycle because manual scenarios already have their own cleanup behavior.

- [ ] **Step 6: Run live-runner regressions**

```bash
node --test tests/feasibility/github-e2e-safety.test.mjs tests/feasibility/github-e2e-remote.test.mjs tests/feasibility/github-e2e-compile-cli.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/github-e2e-remote.mjs scripts/run-github-e2e.mjs tests/feasibility/github-e2e-remote.test.mjs tests/feasibility/github-e2e-safety.test.mjs
git commit -m "fix: preflight and clean destructive github e2e state"
```

---

# Task 4: Qualification Receipt, Process Runner, and Git Authority Primitives

**Files:**
- Create: `scripts/local-release-lib.mjs`
- Create: `scripts/local-release-git.mjs`
- Create: `tests/feasibility/local-release-lib.test.mjs`
- Create: `tests/feasibility/local-release-git.test.mjs`

**Interfaces:**
- `QUALIFICATION_GATES`
- `qualificationTagName(version,sha) -> string`
- `createQualificationReceipt(input) -> object`
- `serializeQualificationReceipt(receipt) -> string`
- `validateQualificationReceipt(receipt,expected) -> object`
- `runCommand(command,args,options) -> {status,stdout,stderr,error?}`
- `runPnpmGate(gate,{cwd,env,platform,comspec}) -> result`
- `readHeadSha`, `requireCleanMaster`, `lookupRemoteRef`, `readRemoteMasterSha`
- `createAnnotatedTagObject`, `fetchAndInspectObservedQualificationTag`, `readCommittedBlob`, `listRemoteStableTags`

- [ ] **Step 1: Write failing receipt-contract tests**

```js
test("receipt serialization is deterministic and ends with one newline", () => {
  const receipt = createQualificationReceipt(validReceiptInput);
  const first = serializeQualificationReceipt(receipt);
  const second = serializeQualificationReceipt(receipt);
  assert.equal(first, second);
  assert.ok(first.endsWith("\n"));
  assert.ok(!first.endsWith("\n\n"));
});

test("receipt requires exact ordered v1 gate array", () => {
  const receipt = createQualificationReceipt(validReceiptInput);
  assert.throws(() => validateQualificationReceipt({ ...receipt, gates: [...receipt.gates].reverse() }, expected), /gates/i);
});
```

Cover wrong schema/kind/repository/SHA/version/result/node/pnpm/e2eSuite, duplicate/missing/extra gates, malformed audit fields.

- [ ] **Step 2: Write Windows process-runner construction tests**

The allowlist is static:

```js
const PNPM_GATES = {
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
};
```

Inject `platform: "win32"` and assert the command is `ComSpec || cmd.exe` with `[/d,/s,/c,<fixed allowlisted string>]`. No SHA/version/branch/token is ever inserted into that shell string.

- [ ] **Step 3: Write real temporary-Git object/ref tests**

Create temp work repo + bare origin. Configure identity and make a commit. Test:

- `git mktag` object targets commit directly,
- tag-to-tag object is detectable/rejected,
- full tag-object SHA may be pushed as refspec source to a qualification ref,
- same-named local tag cannot affect inspection,
- remote ref present/absent/error classification,
- observed object changes between `ls-remote` and fetch are rejected.

- [ ] **Step 4: Prove tests fail**

```bash
node --test tests/feasibility/local-release-lib.test.mjs tests/feasibility/local-release-git.test.mjs
```

Expected: FAIL because modules do not exist.

- [ ] **Step 5: Implement receipt/process helpers**

`runCommand` uses `shell:false` for Git/GitHub executables. `runPnpmGate` uses argv on POSIX and fixed allowlisted `cmd.exe /d /s /c` strings on Windows per Node `.cmd` behavior.

- [ ] **Step 6: Implement remote-ref tri-state reads**

```js
const result = runner("git", ["ls-remote", remote, ref], { cwd, encoding: "utf8" });
if (result.status !== 0) throw new Error(`Remote ref lookup failed: ${ref}`);
const rows = result.stdout.trim() ? result.stdout.trim().split(/\r?\n/u) : [];
if (rows.length === 0) return { kind: "absent" };
if (rows.length !== 1) throw new Error(`Ambiguous remote ref response: ${ref}`);
return { kind: "present", objectSha: rows[0].split(/\s+/u)[0] };
```

Validate object SHA format.

- [ ] **Step 7: Implement race-safe remote qualification inspection**

Algorithm:

```text
observed = git ls-remote origin <qualification-ref>
tempRef = refs/local-qualification-inspect/<random>
git fetch --no-tags origin <qualification-ref>:<tempRef>
require git rev-parse <tempRef> == observed.objectSha
inspect observed.objectSha with git cat-file
finally git update-ref -d <tempRef>
```

If remote moves between first read and fetch, fail closed. Local temp-ref cleanup is allowed because it is not remote publication state.

- [ ] **Step 8: Implement exact committed blob reader**

Use binary `git show HEAD:<path>` output and never working-tree static bytes for release staging.

- [ ] **Step 9: Run Task 4 tests and commit**

```bash
node --test tests/feasibility/local-release-lib.test.mjs tests/feasibility/local-release-git.test.mjs
git add scripts/local-release-lib.mjs scripts/local-release-git.mjs tests/feasibility/local-release-lib.test.mjs tests/feasibility/local-release-git.test.mjs
git commit -m "feat: add exact qualification git authority primitives"
```

---

# Task 5: `qualify:local` Orchestration

**Files:**
- Create: `scripts/local-qualify.mjs`
- Create: `tests/feasibility/local-qualify.test.mjs`
- Modify: `package.json`

**Interfaces:**
- `qualifyLocal({cwd,runner,fetchImpl,now,runId,sleep}) -> Promise<{sha,version,qualificationRef,qualificationTagObjectSha,alreadyQualified}>`
- Public script: `pnpm qualify:local`

- [ ] **Step 1: Write failing event-order and preflight tests**

```js
test("qualification records gates only in v1 receipt order", async () => {
  const events = [];
  await qualifyLocal(testDeps(events));
  assert.deepEqual(events.filter(e => e.kind === "gate").map(e => e.name), [
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
});
```

Add tests proving before gates: dirty/non-master, fetch URL mismatch, pushurl mismatch, remote-master mismatch, metadata mismatch, wrong Node/pnpm, missing Git identity, invalid existing receipt, unsafe/unreadable/default-branch E2E config all stop.

- [ ] **Step 2: Write live+cleanup outcome matrix tests**

Required cases:

```text
live=0, cleanup=ok      -> may continue
live!=0, cleanup=ok     -> fail live
live=0, cleanup=fail    -> fail cleanup
live!=0, cleanup=fail   -> fail with both facts
```

Assert no receipt creation occurs in any failure cell.

- [ ] **Step 3: Write post-gate race and push-reconciliation tests**

Cover master movement, origin pushurl change, qualification ref appearing concurrently, and ambiguous push where only exact this-invocation tag-object SHA reconciles success.

- [ ] **Step 4: Prove failure**

```bash
node --test tests/feasibility/local-qualify.test.mjs
```

Expected: FAIL because `scripts/local-qualify.mjs` does not exist.

- [ ] **Step 5: Implement cheap preflight**

Exact order:

```text
clean/master/HEAD
-> canonical fetch+push origin
-> remote master
-> metadata
-> exact Node/pnpm
-> Git committer identity
-> existing qualification remote inspection
-> E2E env/source-target safety
-> E2E remote metadata/default-branch preflight
```

A valid existing remote receipt may return `alreadyQualified: true` only after source/master/toolchain checks pass.

- [ ] **Step 6: Generate official unique branch and run gates**

Generate run ID from cryptographic randomness in CLI mode. Override only the child `GITHUB_E2E_BRANCH` environment for live E2E.

Run fixed pnpm gates in exact order with build before package validation.

- [ ] **Step 7: Always run bounded official E2E cleanup after live child returns**

Call Task 3 `cleanupE2EBranch` even when live exit is nonzero. Record `github-e2e-cleanup-verified` only after proven absence.

- [ ] **Step 8: Revalidate before receipt creation**

Recheck clean/HEAD, canonical fetch+push endpoints, remote master, metadata/toolchain, and qualification ref absence.

- [ ] **Step 9: Create/push exact annotated receipt**

Use `git mktag`, push raw object SHA to exact qualification ref without force, then inspect remote exact object.

Unknown push outcome follows spec reconciliation; never retry blindly.

- [ ] **Step 10: Add scripts**

```json
"validate:metadata": "node scripts/validate-release-metadata.mjs",
"qualify:local": "node scripts/local-qualify.mjs"
```

- [ ] **Step 11: Run Task 5 tests**

```bash
node --test tests/feasibility/local-qualify.test.mjs tests/feasibility/github-e2e-safety.test.mjs tests/feasibility/github-e2e-remote.test.mjs tests/feasibility/local-release-git.test.mjs
corepack pnpm test:github-e2e:compile
```

Expected: PASS; no real GitHub mutation.

- [ ] **Step 12: Commit**

```bash
git add scripts/local-qualify.mjs tests/feasibility/local-qualify.test.mjs package.json
git commit -m "feat: add fail-closed local qualification command"
```

---

# Task 6: Deterministic Staged Assets and ZIP

**Files:**
- Create: `scripts/package-plugin.mjs`
- Create: `tests/feasibility/package-plugin.test.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- `packagePlugin({cwd,version,runner}) -> Promise<{stagingDir,zipPath,assets}>`
- each asset `{name,path,size,sha256}` with raw lowercase 64-hex digest.

- [ ] **Step 1: Add exact dependency**

Add:

```json
"fflate": "0.8.3"
```

Then:

```bash
corepack pnpm install
```

Expected: lockfile contains exact `fflate@0.8.3`.

- [ ] **Step 2: Write failing staging source tests**

Build a temp Git repo where committed `manifest.json`/`styles.css` contain LF but worktree copies are CRLF-compatible. Assert:

```js
const packaged = await packagePlugin({ cwd, version: "1.0.8", runner });
assert.deepEqual(await readFile(findAsset(packaged, "manifest.json").path), committedManifestBytes);
assert.notDeepEqual(await readFile(findAsset(packaged, "manifest.json").path), transformedWorktreeManifestBytes);
```

Assert `main.js` bytes equal current post-build worktree output.

- [ ] **Step 3: Write failing ZIP contract/determinism tests**

```js
const zipBytes = await readFile(result.zipPath);
const entries = unzipSync(zipBytes);
assert.deepEqual(Object.keys(entries), [
  "obsidian-github-sync-multi-platform/main.js",
  "obsidian-github-sync-multi-platform/manifest.json",
  "obsidian-github-sync-multi-platform/styles.css",
]);
```

Also assert exact four upload assets, no unrelated files, output under `.tmp/release/<version>/`, exact sizes/SHA256.

Spawn the packager in two child environments (`TZ=UTC`, `TZ=Asia/Bangkok`) against identical fixture bytes and require identical ZIP SHA-256.

- [ ] **Step 4: Prove failure**

```bash
node --test tests/feasibility/package-plugin.test.mjs
```

Expected: FAIL because packager does not exist.

- [ ] **Step 5: Implement fresh known staging directory**

Validate version syntax before deriving paths. Remove/recreate only `.tmp/release/<version>/`. Stage static files from `readCommittedBlob`; stage `main.js` from current built file.

- [ ] **Step 6: Implement deterministic ZIP**

```js
const fixed = { level: 9, mtime: new Date(1980, 0, 1, 0, 0, 0), os: 0, attrs: 0 };
const archive = Object.create(null);
for (const name of ["main.js", "manifest.json", "styles.css"]) {
  archive[`obsidian-github-sync-multi-platform/${name}`] = [stagedBytes.get(name), fixed];
}
const zipBytes = zipSync(archive, fixed);
```

Do not use `path.join` for ZIP entry names.

- [ ] **Step 7: Compute local artifact manifest from staged upload files**

Hash all four files with Node SHA-256. The staged paths, not root static worktree paths, are later passed to `gh release create`.

- [ ] **Step 8: Run Task 6 tests plus build/package regression**

```bash
node --test tests/feasibility/package-plugin.test.mjs
corepack pnpm build
corepack pnpm validate:package
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add scripts/package-plugin.mjs tests/feasibility/package-plugin.test.mjs package.json pnpm-lock.yaml
git commit -m "feat: add deterministic staged release artifacts"
```

---

# Task 7: Host-Pinned GitHub Publication and Asset Verification Helpers

**Files:**
- Create: `scripts/local-release-github.mjs`
- Create: `tests/feasibility/local-release-github.test.mjs`

**Interfaces:**
- `requireGithubPublicationAuth({runner,repo}) -> void`
- `createStableRef({runner,repo,version,sha}) -> {kind:"created"}` or throws/ambiguous error
- `readStableRef({runner,repo,version}) -> present/absent`
- `readReleaseState({runner,repo,version}) -> absent/present`
- `createDraftArgs`, `publishDraftArgs`
- `verifyReleaseAssets({runner,repo,version,release,localArtifacts,tempRoot}) -> Promise<void>`

- [ ] **Step 1: Write failing host/auth pinning tests**

Assert:

```text
gh auth status --hostname github.com
gh api --hostname github.com ...
```

and every `gh release` invocation carries explicit canonical `--repo` plus child env `GH_HOST=github.com`.

No helper may rely on `{owner}/{repo}` cwd placeholders or inherited `GH_REPO`.

- [ ] **Step 2: Write failing create-only stable-ref tests**

Zero create:

```js
const response = { ref: "refs/tags/1.0.8", object: { sha } };
assert.deepEqual(createStableRef({ runner: fakeGhSuccess(response), repo, version: "1.0.8", sha }), { kind: "created" });
```

Nonzero 422 + subsequent same-SHA read must throw partial/concurrent/ambiguous rather than returning success.

Also test zero response with wrong ref/SHA, network error, 403/ruleset, malformed JSON.

- [ ] **Step 3: Write failing complete release-list tests**

Command semantics:

```text
gh api --hostname github.com --paginate --slurp repos/<canonical>/releases?per_page=100
```

Parse outer page array, flatten arrays, reject malformed page shape and duplicate exact `tag_name` matches. Successful no-match alone returns absent.

- [ ] **Step 4: Write failing exact asset tests**

Require exact unique name set, `state === "uploaded"`, exact size.

Digest behavior:

- `sha256:<64hex>` -> normalize and compare,
- null/absent digest -> fallback download/hash,
- malformed/non-sha256 digest -> fail closed.

- [ ] **Step 5: Write fallback download-to-file test**

The fallback uses a fresh ignored verification directory and semantic command:

```text
gh release download <version>
  --repo <canonical>
  --pattern <exact-asset-name>
  --output <fresh-temp-file>
```

with `GH_HOST=github.com`.

Assert no `--clobber`/`--skip-existing`; destination must not pre-exist. Hash downloaded file with Node streaming SHA-256 and compare expected size/digest.

- [ ] **Step 6: Prove failure**

```bash
node --test tests/feasibility/local-release-github.test.mjs
```

Expected: FAIL because helper does not exist.

- [ ] **Step 7: Implement publication auth preflight**

Run `gh auth status --hostname github.com`, then authenticated canonical repo read and require push/write capability where the API provides it. Treat inability to prove authenticated canonical access as failure.

- [ ] **Step 8: Implement create-reference mutation**

Use argv equivalent of:

```text
gh api --hostname github.com --method POST repos/<canonical>/git/refs -f ref=refs/tags/<version> -f sha=<sha>
```

After zero exit, perform exact stable-ref read before returning success.

- [ ] **Step 9: Implement complete release state and draft/publish args**

Draft args:

```js
[
  "release", "create", version,
  "--repo", repo,
  "--verify-tag",
  "--draft",
  "--title", version,
  "--generate-notes",
  ...(previousStableTag ? ["--notes-start-tag", previousStableTag] : []),
  ...stagedAssetPaths,
]
```

Publish args:

```js
["release", "edit", version, "--repo", repo, "--draft=false"]
```

No delete/clobber/non-draft-create path exists.

- [ ] **Step 10: Implement asset verifier and fallback file download**

Use exact staged artifact manifest. Delete/recreate only local fresh verification temp directories; never mutate remote assets for verification.

- [ ] **Step 11: Run Task 7 tests and commit**

```bash
node --test tests/feasibility/local-release-github.test.mjs
git add scripts/local-release-github.mjs tests/feasibility/local-release-github.test.mjs
git commit -m "feat: add atomic github publication helpers"
```

---

# Task 8: `release:local` Publication State Machine

**Files:**
- Create: `scripts/local-release.mjs`
- Create: `tests/feasibility/local-release.test.mjs`
- Modify: `package.json`

**Interfaces:**
- `releaseLocal({cwd,version,runner,now}) -> Promise<{version,sha,qualificationTagObjectSha,releaseUrl}>`
- Public script `pnpm release:local -- <version>`

- [ ] **Step 1: Write failing phase-order test**

```js
test("public release is unreachable before all exact verification phases", async () => {
  const events = [];
  await releaseLocal(testReleaseDeps(events));
  assert.deepEqual(events.filter(e => e.phase).map(e => e.phase), [
    "preflight",
    "qualification-snapshot",
    "publication-gates",
    "package",
    "final-pre-mutation-check",
    "stable-ref-create",
    "post-ref-recheck",
    "draft-create",
    "draft-asset-verify",
    "final-publish-check",
    "publish",
    "post-verify",
  ]);
});
```

- [ ] **Step 2: Write failing preflight matrix tests**

Cover invalid version syntax, dirty/non-master, fetch URL mismatch, pushurl mismatch, HEAD/master mismatch, metadata/toolchain mismatch, GitHub auth failure, non-monotonic version, pre-existing stable ref, draft/published release, absent/invalid/nested/wrong-SHA receipt, stale local qualification ref ignored.

- [ ] **Step 3: Write failing race tests at every mutation boundary**

Cases:

- master/evidence moves before stable-ref create -> no mutation,
- stable create succeeds then master/evidence moves -> no draft,
- draft verified then master/evidence/stable ref changes -> no publish,
- staged file changed after manifest -> block before mutation/publish as appropriate.

- [ ] **Step 4: Write ambiguous outcome tests**

- create-ref nonzero + same-SHA ref -> stop, no draft,
- draft-create nonzero + visible draft -> stop, no retry/delete,
- publish nonzero + exact fully published final state -> reconciled success,
- publish nonzero + draft/partial/unknown state -> fail, no delete.

- [ ] **Step 5: Write release-notes baseline tests**

Given stable refs plus qualification refs, choose the highest numerically lower stable triple only. Test no-prior-stable case omits `--notes-start-tag`.

- [ ] **Step 6: Prove failure**

```bash
node --test tests/feasibility/local-release.test.mjs
```

Expected: FAIL because `scripts/local-release.mjs` does not exist.

- [ ] **Step 7: Implement cheap preflight and qualification snapshot**

Order:

```text
version argument
-> clean/master/HEAD
-> canonical fetch+push origin
-> remote master
-> metadata/toolchain
-> github.com auth/write preflight
-> complete remote stable-tag enumeration + monotonicity
-> requested stable-ref absence
-> complete release-list absence
-> remote qualification fetch/validate
-> snapshot qualificationTagObjectSha
```

- [ ] **Step 8: Run publication-machine gates**

Exactly:

```text
install-frozen
build
package-validation
fast-tests
github-e2e-compile
```

Do not rerun live/repeat/recovery/resource/feasibility; exact qualification receipt is authority for those.

- [ ] **Step 9: Stage deterministic exact assets and compute local manifest**

Call Task 6 `packagePlugin`. Before first remote stable mutation, revalidate source/master/origin/evidence/release absence and staged digest manifest.

- [ ] **Step 10: Atomically create stable ref**

Only Task 7 `createStableRef` success may proceed. Any nonzero/unknown stops after inspection.

- [ ] **Step 11: Recheck after stable-ref claim before draft creation**

Require remote master == HEAD, exact qualification object unchanged/valid, stable ref == HEAD, requested release still absent.

- [ ] **Step 12: Create explicit draft from staged paths and verify remote bytes**

On nonzero draft create, inspect and stop. On zero, require exact draft flags and Task 7 exact asset verification.

Do not rely on release `targetCommitish` for exact SHA; the stable Git ref is authority.

- [ ] **Step 13: Final public-publish recheck**

Immediately before `draft=false`, require:

```text
local HEAD/source invariant
canonical origin fetch+push invariant
remote master observed == HEAD
qualification remote object SHA == snapshot and receipt/direct target valid
stable ref == HEAD
draft=true, prerelease=false
exact remote asset bytes == local manifest
```

- [ ] **Step 14: Publish and post-verify regardless of CLI zero/nonzero**

After `gh release edit --draft=false`, fresh final state must prove exact qualification object, stable ref, non-draft/non-prerelease release, exact tag, exact four asset bytes.

For zero exit with failed verification -> fail closed.
For nonzero exit with all final assertions -> report reconciled success.

Report remote-master current value as post-publication audit; do not claim impossible cross-resource atomicity.

- [ ] **Step 15: Add public script**

```json
"release:local": "node scripts/local-release.mjs"
```

CLI requires exactly one version argument after pnpm forwarding and prints phases without secrets.

- [ ] **Step 16: Run Task 8 focused tests**

```bash
node --test tests/feasibility/local-release.test.mjs tests/feasibility/local-release-github.test.mjs tests/feasibility/local-release-git.test.mjs tests/feasibility/package-plugin.test.mjs
```

Expected: PASS.

- [ ] **Step 17: Commit**

```bash
git add scripts/local-release.mjs tests/feasibility/local-release.test.mjs package.json
git commit -m "feat: add verified local stable release state machine"
```

---

# Task 9: Maintainer UX, Documentation, and Full Verification

**Files:**
- Modify: `docs/releasing.md`
- Modify: `docs/github-e2e.md`
- Modify: `.env.github-e2e.example`
- Verify: all implementation files from Tasks 1-8.

- [ ] **Step 1: Update official release runbook**

Document exact public flow:

```text
corepack pnpm install --frozen-lockfile
pnpm qualify:local
pnpm release:local -- 1.0.8
```

Prerequisites:

- clean canonical `master`,
- canonical fetch **and push** origin endpoints,
- Node v22.11.0,
- Corepack pnpm 9.12.3,
- Git committer/tagger identity and tag-push auth for qualification receipt,
- GitHub CLI auth on `github.com` with canonical Contents write permission,
- dedicated disposable E2E repository/token,
- possible OAuth `workflow` scope remediation if GitHub CLI explicitly requires it.

- [ ] **Step 2: Document stable state/recovery model**

```text
qualification receipt
-> create-only stable ref
-> explicit draft
-> verified remote assets
-> published release
-> post-verification
```

Explain that a pre-existing stable ref/draft is inspection-only in v1; commands do not auto-resume/delete/clobber.

- [ ] **Step 3: Document realistic Actions semantics**

State explicitly:

- local authority does not require/wait for/trust Actions,
- existing `ci.yml` listens to unfiltered push and tag creation may trigger incidental CI,
- such runs are non-authoritative,
- Actions release path remains independent.

- [ ] **Step 4: Update E2E docs/example**

`.env.github-e2e.example`:

```text
GITHUB_E2E_OWNER=your-owner
GITHUB_E2E_REPO=your-dedicated-test-repo
# Manual E2E branch. Official pnpm qualify:local overrides this with a unique run-specific branch.
GITHUB_E2E_BRANCH=e2e-destructive
GITHUB_E2E_TOKEN=github_pat_or_fine_grained_token
```

Document manual fork support, current-origin/canonical-source rejection, actual default-branch preflight, official unique branch, bounded qualifier cleanup, and hard-kill residue inspection.

- [ ] **Step 5: Run the complete deterministic repository suite**

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

Do not run a real source-repository qualification/ref/release mutation as an ordinary implementation test.

- [ ] **Step 6: Run every focused new safety test explicitly**

```bash
node --test tests/feasibility/release-metadata.test.mjs tests/feasibility/github-e2e-safety.test.mjs tests/feasibility/github-e2e-remote.test.mjs tests/feasibility/local-release-lib.test.mjs tests/feasibility/local-release-git.test.mjs tests/feasibility/local-qualify.test.mjs tests/feasibility/package-plugin.test.mjs tests/feasibility/local-release-github.test.mjs tests/feasibility/local-release.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Run static branch-scope checks**

```bash
git diff --check master...HEAD
git diff --name-only master...HEAD
```

Confirm `.github/workflows/github-e2e-live.yml` and `.github/workflows/release.yml` are unchanged.

- [ ] **Step 8: Record native-Windows verification requirement**

Before first production Windows release, run the focused test command from Step 6 natively on Windows using Node v22.11.0/pnpm 9.12.3. Record command + exit status in the release checklist. Injected win32 construction tests alone are not the evidence for the first real Windows publication.

- [ ] **Step 9: Commit docs**

```bash
git add docs/releasing.md docs/github-e2e.md .env.github-e2e.example
git commit -m "docs: document audited local release workflow"
```

- [ ] **Step 10: Final acceptance review**

Review every acceptance criterion in the v2 spec and record:

```text
final branch HEAD SHA
Node version
pnpm version
all verification commands and exit codes
confirmation no real stable source tag/release was created by tests
confirmation Actions release/E2E YAML files are unchanged
remaining rollout: merge -> qualify exact final master -> inspect receipt -> release exact qualified version -> inspect final assets
```

Do not merge or run the real publication until this review is clean.