# Live GitHub E2E Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make release-qualifying real-GitHub E2E execute exact CI-produced bundles on a fresh runner against one pinned disposable repository, with target credentials isolated from build tooling and one cohesive workflow attempt carrying qualification, provenance receipt, scenario execution, and cleanup.

**Architecture:** Ordinary read-only `ci.yml` is the only compiler of the three live-E2E bundles and uploads a strict provenance manifest with them. `github-e2e-live.yml` becomes a no-checkout/no-install/no-build consumer: it selects the newest exact-SHA CI producer/current attempt, verifies and extracts that artifact, proves a pinned numeric target repository identity, persists a same-attempt receipt before any target mutation, runs only the three fixed bundles serially, and performs cleanup by independently re-resolving the currently configured route against the same pinned ID. Release qualification never mixes jobs or artifacts across workflow attempts; a cleanup-only rerun is maintenance evidence only until all jobs are rerun cohesively.

**Tech Stack:** Node.js `v22.11.0`, TypeScript, ESM, esbuild, Node `node:test`, pnpm `9.12.3`, GitHub Actions, GitHub REST Git refs/Actions/artifact APIs, pinned external Actions.

**Spec:** `docs/superpowers/specs/2026-08-30-live-github-e2e-safety-design.md`

## Global Constraints

- Repository baseline for the approved design is `35e98cea924702293bde62d064a83d52eca6d898`; rebase/re-review if `master` materially changes before execution.
- Release-qualifying live E2E runs only for exact current `master` and consumes the newest matching exact-SHA ordinary CI `push` run/current attempt; older successful CI runs/attempts are never fallback authority.
- CI is the sole compiler of release-qualifying live-E2E bundles. Credentialed live workflow must not checkout repository code, run pnpm/npm, install project dependencies, build, or compile.
- Live target credential is step-scoped, never job-level state, and its mutable scope is limited to the dedicated disposable target repository.
- `E2E_REPO_ID` is mandatory maintainer-pinned numeric target identity for Actions qualification. Owner/repository names are routing only.
- Release-qualifying branch is exactly `obsidian-sync-e2e/run-${GITHUB_RUN_ID}` and must not equal target actual default branch.
- Readable initialized target default-branch Git ref is required before interpreting exact disposable-ref absence.
- Qualification receipt persists successfully before scenario target mutation.
- Receipt is same-attempt provenance only; it never bridges old attempts for cleanup or qualification.
- Release qualification requires current/latest live workflow attempt to contain successful `qualify` + successful `cleanup` + valid same-attempt receipt.
- A cleanup-only partial rerun is not release qualification. To regain qualification, use Re-run all jobs.
- Default source `GITHUB_TOKEN` remains read-only.
- Every external `uses:` reference in repository workflows is pinned to a verified full-length commit SHA.
- Do not change V4 publication-race retry classification in this child; Child C owns those changes.
- Do not change stable-release publication semantics beyond mechanical full-SHA action pinning; Child A owns release redesign.
- No new npm dependency is required.

## File Structure

### New files

- `scripts/github-e2e-input.mjs` — deterministic E2E bundle names/output + CI provenance manifest hashing in ordinary/local source contexts.
- `tests/github-e2e/support/target-safety.ts` — single target identity/ref-capability/reset authority bundled into all credentialed E2E suites.
- `tests/feasibility/github-actions-pinning.test.mjs` — repository-wide external Action full-SHA contract.
- `tests/feasibility/github-e2e-input.test.mjs` — compile-output/manifest/CI-artifact contract.
- `tests/feasibility/github-e2e-target-safety.test.ts` — deterministic mocked GitHub REST target-safety matrix.
- `tests/feasibility/github-e2e-suite-safety-contract.test.mjs` — proves all three credentialed suites consume shared helper and no longer own reset logic.
- `tests/feasibility/github-e2e-live-workflow-contract.test.mjs` — static semantic/order contract for no-build live workflow, same-attempt receipt, independent cleanup, cohesive qualification.

### Modified files

- `scripts/run-github-e2e.mjs` — shared bundle producer; caller-owned compile output; no `.env.github-e2e` load in compile-only mode; expected target ID required for credentialed local runs.
- `tests/feasibility/github-e2e-compile-cli.test.mjs` — compile-only and local-ID regressions.
- `tests/github-e2e/v4-real-github-e2e.test.ts` — shared target/reset helper.
- `tests/github-e2e/v4-copy-contract-github-e2e.test.ts` — shared target/reset helper; preserve Child-C retry semantics.
- `tests/github-e2e/v4-encrypted-external-mutation.test.ts` — shared target/reset helper.
- `.github/workflows/ci.yml` — compile once to fixed directory, write provenance manifest, upload E2E input only for master push.
- `.github/workflows/github-e2e-live.yml` — verified CI-artifact executor with same-attempt receipt and independently guarded cleanup.
- `.github/workflows/pre-release.yml` — mechanical full-SHA Action pinning only.
- `.github/workflows/release.yml` — mechanical full-SHA Action pinning only.
- `docs/github-e2e.md` — pinned target ID, environment branch restriction, CI-artifact flow, cohesive rerun policy, safe cleanup.
- `docs/releasing.md` — update only live-E2E configuration/qualification portion.

---

### Task 1: Pin Every External GitHub Action by Full Commit SHA

**Files:**
- Create: `tests/feasibility/github-actions-pinning.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/github-e2e-live.yml`
- Modify: `.github/workflows/pre-release.yml`
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: all `.yml`/`.yaml` files in `.github/workflows/`.
- Produces: invariant `external uses => @<40 lowercase hex commit SHA>`; local `uses: ./...` remains allowed.

- [ ] **Step 1: Write failing repository-wide pinning test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workflowDir = resolve(".github/workflows");

function externalUse(line) {
  const match = line.match(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/u);
  if (!match || match[1].startsWith("./")) return null;
  return match[1];
}

test("all external workflow actions are pinned to full commit SHAs", async () => {
  const names = (await readdir(workflowDir)).filter(name => /\.ya?ml$/u.test(name)).sort();
  const failures = [];
  for (const name of names) {
    const text = await readFile(resolve(workflowDir, name), "utf8");
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      const value = externalUse(line);
      if (value && !/^[^@\s]+@[0-9a-f]{40}$/u.test(value)) failures.push(`${name}:${index + 1}: ${value}`);
    }
  }
  assert.deepEqual(failures, []);
});
```

- [ ] **Step 2: Run focused test and prove current mutable refs fail**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-actions-pinning
```

Expected: FAIL listing current `@v4`/`@v6` refs.

- [ ] **Step 3: Pin verified action commits**

```yaml
uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
```

Do not redesign release/pre-release workflows here.

- [ ] **Step 4: Verify**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-actions-pinning
corepack pnpm test:feasibility
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows tests/feasibility/github-actions-pinning.test.mjs
git commit -m "build: pin github actions by commit sha"
```

---

### Task 2: Make CI Produce One Provenance-Bound E2E Bundle Artifact

**Files:**
- Create: `scripts/github-e2e-input.mjs`
- Create: `tests/feasibility/github-e2e-input.test.mjs`
- Modify: `scripts/run-github-e2e.mjs`
- Modify: `tests/feasibility/github-e2e-compile-cli.test.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

```js
export const GITHUB_E2E_BUNDLES = Object.freeze([
  "v4-real-github-e2e.test.mjs",
  "v4-copy-contract-github-e2e.test.mjs",
  "v4-encrypted-external-mutation.test.mjs",
]);
export async function compileGitHubE2EBundles({ root, outDir })
export async function writeGitHubE2EInputManifest({ outDir, env, nodeVersion })
```

CLI additions:

```text
--out-dir=<path>
--write-input-manifest
```

CI artifact:

```text
github-e2e-input-${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

Exact entries: manifest + three bundles.

- [ ] **Step 1: Extend compile-only tests first**

Add a test using explicit missing `GITHUB_E2E_ENV_FILE`; compile-only must still succeed, proving it never loads target env files. Use a temp output directory, pre-create a stale file, then assert exact output names and stale-file removal.

```js
const result = spawnSync(process.execPath, [
  resolve("scripts/run-github-e2e.mjs"),
  "--compile-only",
  `--out-dir=${outDir}`,
], { cwd: resolve("."), env, encoding: "utf8" });
assert.equal(result.status, 0, result.stderr || result.stdout);
assert.deepEqual((await readdir(outDir)).sort(), [
  "v4-copy-contract-github-e2e.test.mjs",
  "v4-encrypted-external-mutation.test.mjs",
  "v4-real-github-e2e.test.mjs",
]);
```

- [ ] **Step 2: Write failing manifest tests**

```js
import { GITHUB_E2E_BUNDLES, writeGitHubE2EInputManifest } from "../../scripts/github-e2e-input.mjs";

const manifest = await writeGitHubE2EInputManifest({
  outDir,
  env: {
    GITHUB_REPOSITORY_ID: "1282135059",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "1234",
    GITHUB_RUN_ATTEMPT: "2",
  },
  nodeVersion: "v22.11.0",
});
assert.equal(manifest.repositoryId, "1282135059");
assert.equal(manifest.commitSha, "a".repeat(40));
assert.equal(manifest.workflowRunId, "1234");
assert.equal(manifest.workflowRunAttempt, 2);
assert.deepEqual(manifest.bundles.map(item => item.name), GITHUB_E2E_BUNDLES);
```

Add negatives: missing producer env, non-40-hex SHA, invalid attempt, missing bundle, unexpected extra entry.

- [ ] **Step 3: Prove tests fail**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-compile-cli
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-input
```

- [ ] **Step 4: Implement producer module**

```js
import { createHash } from "node:crypto";
import { readFile, readdir, rm, mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

export const GITHUB_E2E_ENTRY_POINTS = Object.freeze([
  "tests/github-e2e/v4-real-github-e2e.test.ts",
  "tests/github-e2e/v4-copy-contract-github-e2e.test.ts",
  "tests/github-e2e/v4-encrypted-external-mutation.test.ts",
]);
export const GITHUB_E2E_BUNDLES = Object.freeze(GITHUB_E2E_ENTRY_POINTS.map(value => value.split("/").at(-1).replace(/\.ts$/u, ".mjs")));

export async function compileGitHubE2EBundles({ root = process.cwd(), outDir }) {
  if (!outDir) throw new Error("GitHub E2E output directory is required.");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const outputs = [];
  for (let index = 0; index < GITHUB_E2E_ENTRY_POINTS.length; index++) {
    const outfile = resolve(outDir, GITHUB_E2E_BUNDLES[index]);
    await build({
      entryPoints: [resolve(root, GITHUB_E2E_ENTRY_POINTS[index])],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      alias: { obsidian: resolve(root, "tests/stubs/obsidian.ts") },
      logLevel: "silent",
    });
    outputs.push(outfile);
  }
  return outputs;
}

export async function writeGitHubE2EInputManifest({ outDir, env = process.env, nodeVersion = process.version }) {
  // Validate repository ID/run ID as canonical decimal strings, SHA as 40 lowercase hex,
  // and run attempt as positive integer. Require directory contains only the 3 bundles.
  // Hash each regular file with SHA-256; then write github-e2e-input.json with schemaVersion:1.
}
```

The implementation of `writeGitHubE2EInputManifest` must contain the exact validation described by tests; do not leave permissive coercion.

- [ ] **Step 5: Refactor runner**

Determine compile mode before env-file loading:

```js
const compileOnly = process.argv.includes("--compile-only") || process.env.GITHUB_E2E_COMPILE_ONLY === "1";
if (!compileOnly) loadEnvFile();
```

Use `compileGitHubE2EBundles()` for compile-only/local execution. Parse `--out-dir=`. If `--write-input-manifest` is present, call manifest writer after compile.

- [ ] **Step 6: Update CI**

```yaml
- name: Compile real GitHub E2E harness
  run: >-
    node scripts/run-github-e2e.mjs
    --compile-only
    --out-dir=.tmp/github-e2e-input
    --write-input-manifest

- name: Upload release-qualifying GitHub E2E input
  if: github.event_name == 'push' && github.ref == 'refs/heads/master'
  uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  with:
    name: github-e2e-input-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}
    path: .tmp/github-e2e-input
    if-no-files-found: error
```

Keep current ordinary plugin artifact unchanged in Child B.

- [ ] **Step 7: Add CI raw-text contract**

Assert fixed output directory, manifest flag, master-push condition, exact artifact naming.

- [ ] **Step 8: Verify**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-compile-cli
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-input
corepack pnpm test:github-e2e:compile
```

- [ ] **Step 9: Commit**

```bash
git add scripts/github-e2e-input.mjs scripts/run-github-e2e.mjs tests/feasibility/github-e2e-compile-cli.test.mjs tests/feasibility/github-e2e-input.test.mjs .github/workflows/ci.yml
git commit -m "test: produce provenance-bound github e2e bundles"
```

---

### Task 3: Build Shared Target-Safety Authority with Mocked REST Tests

**Files:**
- Create: `tests/github-e2e/support/target-safety.ts`
- Create: `tests/feasibility/github-e2e-target-safety.test.ts`

**Interfaces:**

```ts
export interface GitHubE2ETargetEnvironment {
  owner: string
  repo: string
  branch: string
  token: string
  expectedRepositoryId: string
  sourceRepositoryId?: string
  requiredBranch?: string
}
export interface ResolvedGitHubE2ETarget {
  config: GitHubConfig
  repositoryId: string
  fullName: string
  defaultBranch: string
  defaultBranchSha: string
}
export type GitHubE2EFetch = (url: string, init?: RequestInit) => Promise<Response>
export function readGitHubE2ETargetEnvironment(env?: NodeJS.ProcessEnv): GitHubE2ETargetEnvironment
export function encodeGitHubE2ERefPath(branch: string): string
export async function resolveGitHubE2ETarget(input: GitHubE2ETargetEnvironment, request?: GitHubE2EFetch): Promise<ResolvedGitHubE2ETarget>
export async function resetGitHubE2EDisposableBranch(input: GitHubE2ETargetEnvironment, request?: GitHubE2EFetch): Promise<ResolvedGitHubE2ETarget>
```

- [ ] **Step 1: Write safety matrix first**

Required tests:

```ts
test("rejects case-different route resolving to source numeric ID", async () => {})
test("rejects target ID mismatch with pinned ID", async () => {})
test("rejects actual default branch regardless of its name", async () => {})
test("rejects branch differing from required Actions branch", async () => {})
test("metadata failure fails closed", async () => {})
test("default-branch ref unreadable fails closed", async () => {})
test("exact disposable 404 accepted only after capability success", async () => {})
test("arbitrary 422 is rejected", async () => {})
test("recognized missing-reference validation accepted only after capability", async () => {})
test("concurrent already-absent DELETE still performs final capability+absence verification", async () => {})
test("post-delete loss of default-ref capability fails", async () => {})
test("credentialed env parsing requires numeric expected repo ID", () => {})
```

Fake fetch records method+URL order.

- [ ] **Step 2: Prove module missing**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-target-safety
```

- [ ] **Step 3: Implement strict env/ref helpers**

```ts
const FORBIDDEN_LOCAL_BRANCHES = new Set(["main", "master", "production", "prod", "release", "stable"])

export function readGitHubE2ETargetEnvironment(env = process.env): GitHubE2ETargetEnvironment {
  const branch = required(env, "GITHUB_E2E_BRANCH")
  const expectedRepositoryId = required(env, "GITHUB_E2E_EXPECTED_REPO_ID")
  if (!/^[1-9][0-9]*$/u.test(expectedRepositoryId)) throw new Error("GITHUB_E2E_EXPECTED_REPO_ID must be a numeric GitHub repository ID.")
  if (FORBIDDEN_LOCAL_BRANCHES.has(branch.toLowerCase())) throw new Error(`Refusing destructive GitHub E2E branch: ${branch}`)
  return {
    owner: required(env, "GITHUB_E2E_OWNER"),
    repo: required(env, "GITHUB_E2E_REPO"),
    branch,
    token: required(env, "GITHUB_E2E_TOKEN"),
    expectedRepositoryId,
    sourceRepositoryId: env.GITHUB_E2E_SOURCE_REPO_ID?.trim() || undefined,
    requiredBranch: env.GITHUB_E2E_REQUIRED_BRANCH?.trim() || undefined,
  }
}

export function encodeGitHubE2ERefPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/")
}
```

- [ ] **Step 4: Implement metadata/default-ref proof**

Require metadata `id/full_name/default_branch`, pinned ID equality, source inequality when supplied, required-branch equality when supplied, branch != actual default. Then read actual default-branch Git ref and require 200 + object SHA.

- [ ] **Step 5: Implement exact absence classification/reset**

Only after capability proof recognize exact-ref `404` or `422` whose parsed message is exactly `Reference does not exist`. For present ref, DELETE; accept `204` or recognized concurrent absence; then re-prove default-ref readability and boundedly verify disposable ref absence. Ambiguous responses fail closed. Never log token.

- [ ] **Step 6: Verify**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-target-safety
```

- [ ] **Step 7: Commit**

```bash
git add tests/github-e2e/support/target-safety.ts tests/feasibility/github-e2e-target-safety.test.ts
git commit -m "test: centralize github e2e target safety"
```

---

### Task 4: Migrate All Credentialed Suites and Local Runner to Pinned-ID Contract

**Files:**
- Create: `tests/feasibility/github-e2e-suite-safety-contract.test.mjs`
- Modify: `tests/github-e2e/v4-real-github-e2e.test.ts`
- Modify: `tests/github-e2e/v4-copy-contract-github-e2e.test.ts`
- Modify: `tests/github-e2e/v4-encrypted-external-mutation.test.ts`
- Modify: `scripts/run-github-e2e.mjs`
- Modify: `tests/feasibility/github-e2e-compile-cli.test.mjs`

**Interfaces:**
- All suites import shared target helper.
- Credentialed local execution requires `GITHUB_E2E_EXPECTED_REPO_ID`.
- Actions additionally supplies source repo ID + exact required branch.
- Existing scenario semantics/Child-C retry code unchanged.

- [ ] **Step 1: Write static suite-consumer regression**

```js
const suites = [
  "tests/github-e2e/v4-real-github-e2e.test.ts",
  "tests/github-e2e/v4-copy-contract-github-e2e.test.ts",
  "tests/github-e2e/v4-encrypted-external-mutation.test.ts",
];
for (const file of suites) {
  const text = await readFile(resolve(file), "utf8");
  assert.match(text, /\.\/support\/target-safety/u, file);
  assert.match(text, /resetGitHubE2EDisposableBranch/u, file);
  assert.doesNotMatch(text, /async function deleteTestBranch/u, file);
  assert.doesNotMatch(text, /const forbiddenBranches/u, file);
}
```

- [ ] **Step 2: Add local runner missing-ID regression**

Provide owner/repo/branch/token but omit `GITHUB_E2E_EXPECTED_REPO_ID`; assert exit status 2 and missing-ID message before network/test execution.

- [ ] **Step 3: Prove failures**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-suite-safety-contract
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-compile-cli
```

- [ ] **Step 4: Require expected ID in non-compile runner**

```js
const required = [
  "GITHUB_E2E_OWNER",
  "GITHUB_E2E_REPO",
  "GITHUB_E2E_BRANCH",
  "GITHUB_E2E_TOKEN",
  "GITHUB_E2E_EXPECTED_REPO_ID",
];
```

- [ ] **Step 5: Migrate suites**

```ts
import {
  encodeGitHubE2ERefPath,
  readGitHubE2ETargetEnvironment,
  resetGitHubE2EDisposableBranch,
  resolveGitHubE2ETarget,
} from "./support/target-safety"

const targetEnvironment = readGitHubE2ETargetEnvironment()
const initialTarget = await resolveGitHubE2ETarget(targetEnvironment)
const github = initialTarget.config
```

Replace every scenario-start/after reset with `await resetGitHubE2EDisposableBranch(targetEnvironment)`. Use shared ref encoder for external-interference paths. Remove duplicate forbidden/env/delete logic.

Do not alter main/copy wrapper retry classification or `conflictCopyStages.clear()`.

- [ ] **Step 6: Verify**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-suite-safety-contract
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-compile-cli
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-target-safety
corepack pnpm test:github-e2e:compile
```

- [ ] **Step 7: Commit**

```bash
git add scripts/run-github-e2e.mjs tests/github-e2e tests/feasibility/github-e2e-suite-safety-contract.test.mjs tests/feasibility/github-e2e-compile-cli.test.mjs
git commit -m "test: enforce pinned live e2e repository identity"
```

---

### Task 5: Rewrite GitHub E2E Live as Verified CI-Artifact Executor

**Files:**
- Create: `tests/feasibility/github-e2e-live-workflow-contract.test.mjs`
- Modify: `.github/workflows/github-e2e-live.yml`

**Interfaces:**

Environment:

```text
vars.E2E_OWNER
vars.E2E_REPO
vars.E2E_REPO_ID
secrets.E2E_TOKEN
```

Receipt artifact for each qualify attempt:

```text
github-e2e-target-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

with sole file `github-e2e-target.json`.

Release qualification later requires the authoritative live run **current attempt** to contain successful `qualify`, successful `cleanup`, and valid same-attempt receipt. Cleanup itself uses configured route + pinned ID and does not use receipt/old attempt outputs as safety authority.

- [ ] **Step 1: Write failing workflow contract**

```js
const text = await readFile(resolve(".github/workflows/github-e2e-live.yml"), "utf8");
assert.match(text, /actions:\s*read/u);
assert.match(text, /contents:\s*read/u);
assert.doesNotMatch(text, /actions\/checkout@/u);
assert.doesNotMatch(text, /pnpm\/action-setup@/u);
assert.doesNotMatch(text, /pnpm install|pnpm build|run-github-e2e\.mjs/u);
assert.match(text, /github-e2e-input-/u);
assert.match(text, /E2E_REPO_ID/u);
assert.match(text, /github-e2e-target-/u);
assert.match(text, /node --test --test-concurrency=1/u);
assert.doesNotMatch(text, /^ {4}env:/mu); // no job-level env blocks
```

Add ordering assertion receipt upload before bundle execution; assert both jobs `environment: github-e2e`, cleanup `if: always()`, run-derived branch literal, and no cleanup logic reading an old receipt artifact or `needs.qualify.outputs` as identity authority.

- [ ] **Step 2: Prove old workflow fails**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-live-workflow-contract
```

- [ ] **Step 3: Set workflow permissions/jobs**

```yaml
permissions:
  actions: read
  contents: read

concurrency:
  group: github-e2e-live
  cancel-in-progress: false
```

`qualify` and `cleanup` reference `environment: github-e2e`; neither has job-level `env:`.

- [ ] **Step 4: Implement authoritative CI current-attempt selection**

Fixed workflow-owned code must:

1. require source ref `master`,
2. require current source master SHA == `GITHUB_SHA`,
3. paginate matching `ci.yml` `push` runs for exact SHA/master,
4. choose newest by `created_at`, tie-break numeric run ID,
5. require newest run completed/successful,
6. read that run's **current `run_attempt`** and attempt-specific jobs; require `verify` executed/completed/successful in that same attempt,
7. locate exact unexpired artifact `github-e2e-input-${GITHUB_SHA}-${CI_RUN_ID}-${CI_RUN_ATTEMPT}` pagination-safely,
8. fetch exact source `.node-version`,
9. expose only non-secret CI run/attempt/artifact/digest/node outputs.

Pagination helper shape:

```js
async function listAll(path, key) {
  const values = [];
  for (let page = 1; ; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await api(`${path}${separator}per_page=100&page=${page}`);
    const pageValues = response[key] ?? [];
    values.push(...pageValues);
    if (pageValues.length < 100) return values;
  }
}
```

Do not search for “any successful run”.

- [ ] **Step 5: Download/verify exact CI artifact before target secret exposure**

Download by numeric artifact ID through GitHub REST with source read token. When REST exposes `digest: sha256:<hex>`, verify downloaded archive digest. GitHub documents artifact digest as SHA-256 of uploaded artifact; keep inner manifest hashes as the independent file-level integrity authority.

Before extraction reject absolute paths, `..`, backslash ambiguity, duplicate names, directories, symlinks, extra/missing entries. Exact archive logical entries are manifest + 3 bundles. Parse manifest strictly and require source repo ID/SHA/run/current attempt/Node version/bundle names/sizes/hashes. Write only validated bytes into fresh `.tmp/github-e2e-verified`.

- [ ] **Step 6: Set up exact Node runtime only**

```yaml
- name: Setup exact Node.js runtime
  uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
  with:
    node-version: ${{ steps.ci.outputs.node_version }}
```

No pnpm cache/install/build/compile.

- [ ] **Step 7: Resolve pinned target with step-scoped credential**

```yaml
env:
  E2E_OWNER: ${{ vars.E2E_OWNER }}
  E2E_REPO: ${{ vars.E2E_REPO }}
  E2E_REPO_ID: ${{ vars.E2E_REPO_ID }}
  E2E_TOKEN: ${{ secrets.E2E_TOKEN }}
  E2E_BRANCH: obsidian-sync-e2e/run-${{ github.run_id }}
```

Fixed code resolves metadata and requires resolved ID == pinned ID, ID != source ID, non-empty canonical full name/default branch, branch != default, and GET actual default-branch Git ref == 200 with object SHA. Emit non-secret canonical owner/repo/ID/default/branch outputs only.

- [ ] **Step 8: Persist same-attempt receipt before mutation**

Without target token in this step, write exactly:

```json
{
  "schemaVersion": 1,
  "sourceRepositoryId": "...",
  "sourceCommitSha": "...",
  "workflowRunId": "...",
  "workflowRunAttempt": 1,
  "ciProducerRunId": "...",
  "ciProducerRunAttempt": 1,
  "ciE2EArtifactId": "...",
  "ciE2EArtifactDigest": "sha256:... or null",
  "targetRepositoryId": "...",
  "targetFullName": "owner/repo",
  "targetDefaultBranch": "trunk",
  "targetBranch": "obsidian-sync-e2e/run-123"
}
```

Upload blocking:

```yaml
- name: Upload same-attempt qualification receipt
  uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  with:
    name: github-e2e-target-${{ github.run_id }}-${{ github.run_attempt }}
    path: .tmp/github-e2e-receipt/github-e2e-target.json
    if-no-files-found: error
```

No `continue-on-error`.

- [ ] **Step 9: Execute exact bundles serially with step-scoped target credential**

```yaml
- name: Run verified real GitHub E2E bundles
  env:
    GITHUB_E2E_OWNER: ${{ steps.target.outputs.owner }}
    GITHUB_E2E_REPO: ${{ steps.target.outputs.repo }}
    GITHUB_E2E_BRANCH: obsidian-sync-e2e/run-${{ github.run_id }}
    GITHUB_E2E_REQUIRED_BRANCH: obsidian-sync-e2e/run-${{ github.run_id }}
    GITHUB_E2E_EXPECTED_REPO_ID: ${{ vars.E2E_REPO_ID }}
    GITHUB_E2E_SOURCE_REPO_ID: ${{ github.repository_id }}
    GITHUB_E2E_TOKEN: ${{ secrets.E2E_TOKEN }}
  run: |
    set -euo pipefail
    node --test --test-concurrency=1 \
      .tmp/github-e2e-verified/v4-real-github-e2e.test.mjs \
      .tmp/github-e2e-verified/v4-copy-contract-github-e2e.test.mjs \
      .tmp/github-e2e-verified/v4-encrypted-external-mutation.test.mjs
```

- [ ] **Step 10: Make cleanup independent and fail closed**

`cleanup` gets current `E2E_OWNER/E2E_REPO/E2E_REPO_ID/E2E_TOKEN` only in its cleanup step. It does **not** download old receipt artifacts and does not require `needs.qualify.outputs` for target identity.

Before exact ref removal it independently:

```text
requires configured route nonempty
requires pinned ID canonical numeric
resolves current route metadata
requires resolved ID == pinned E2E_REPO_ID
requires resolved ID != source repository ID
requires branch == obsidian-sync-e2e/run-${GITHUB_RUN_ID}
requires branch != current default branch
requires current default-branch Git ref readable
reads exact disposable ref
```

If exact ref is recognized absent after capability proof, succeed. If present, delete exact ref; accept 204 or recognized concurrent absence; then re-prove default-ref capability and boundedly verify exact absence. Ambiguous route/ID/ref responses mutate nothing and fail.

A cleanup-only rerun may therefore clean residue safely, but it does not create a same-attempt `qualify`/receipt and cannot become release qualification.

- [ ] **Step 11: Add static cohesive-attempt contract**

The feasibility test must assert receipt name includes `${{ github.run_attempt }}` and docs/static markers make the intended rule explicit. It cannot prove GitHub job result semantics; final live run is authoritative execution evidence.

- [ ] **Step 12: Verify**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-live-workflow-contract
node scripts/run-tests.mjs --tier=feasibility --filter=github-actions-pinning
corepack pnpm test:feasibility
corepack pnpm test:github-e2e:compile
```

- [ ] **Step 13: Commit**

```bash
git add .github/workflows/github-e2e-live.yml tests/feasibility/github-e2e-live-workflow-contract.test.mjs
git commit -m "ci: run live github e2e from verified ci bundles"
```

---

### Task 6: Update Maintainer and Emergency-Cleanup User Flow

**Files:**
- Modify: `docs/github-e2e.md`
- Modify: `docs/releasing.md`

**Interfaces:**

One-time environment:

```text
Variable: E2E_OWNER
Variable: E2E_REPO
Variable: E2E_REPO_ID
Secret:   E2E_TOKEN
Deployment branches/tags: Selected branches and tags -> master only; no tags
```

Local credentialed execution adds:

```text
GITHUB_E2E_EXPECTED_REPO_ID=<numeric target id>
```

- [ ] **Step 1: Rewrite local/manual configuration**

Document owner/repo/expected numeric ID/branch/token. State release-qualifying credential scope is target-repository-only, not merely preferred. Preserve `pnpm test:github-e2e:quick` convenience and explain local compile+run is intentionally different from fresh-runner Actions qualification.

- [ ] **Step 2: Rewrite Actions environment setup**

```text
Settings -> Environments -> github-e2e
Deployment branches and tags -> Selected branches and tags
Allowed branch -> master
No tags
```

Warn against `Protected branches only` while master is unprotected. Explain numeric ID is authority and owner/repo is route.

- [ ] **Step 3: Replace blind manual cleanup snippet**

Require:

```text
known expected numeric target ID
-> resolve current configured route
-> require resolved ID == expected ID
-> require branch obsidian-sync-e2e/run-<RUN_ID>
-> require branch != actual default
-> read actual default ref successfully
-> inspect exact disposable ref
-> delete only if present
-> read default ref again
-> verify exact disposable ref absent
```

No arbitrary 404-success before capability proof.

- [ ] **Step 4: Document cohesive rerun policy**

```text
cleanup fails -> Re-run failed jobs may be used to clean residue
cleanup-only attempt is NOT release qualification
for release qualification -> Re-run all jobs
new attempt must produce its own receipt, rerun exact bundles, and cleanup successfully
```

- [ ] **Step 5: Update only Child-B portion of `docs/releasing.md`**

Qualification becomes:

```text
ordinary CI exact master current attempt succeeds
-> current github-e2e-input artifact exists
-> GitHub E2E Live consumes it
-> same-attempt receipt persists before target mutation
-> qualify succeeds
-> cleanup succeeds in same attempt
```

Do not redesign Stable Release section yet.

- [ ] **Step 6: Verify docs-sensitive gates**

```bash
corepack pnpm test:feasibility
corepack pnpm test:github-e2e:compile
```

- [ ] **Step 7: Commit**

```bash
git add docs/github-e2e.md docs/releasing.md
git commit -m "docs: harden live github e2e runbook"
```

---

### Task 7: Verify Child B End-to-End Before Handoff

**Files:**
- No planned source change. Any defect exposed here gets a failing regression + focused fix commit.

**Interfaces:**
- Produces deterministic branch evidence and, after merge/configuration, one exact-final-master live workflow whose current attempt has successful `qualify`, valid same-attempt receipt, and successful `cleanup`.

- [ ] **Step 1: Attempt complete deterministic local gate**

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
corepack pnpm test:repeat
corepack pnpm test:recovery
corepack pnpm test:resource
corepack pnpm test:feasibility
corepack pnpm test:github-e2e:compile
corepack pnpm validate:package
```

If local environment cannot run, record exact failure and rely on pushed GitHub Actions evidence; never claim local pass.

- [ ] **Step 2: Inspect child-boundary diff**

Require:

```text
no Child-C typed-race implementation
no Child-A release redesign beyond action pins
no live checkout/install/build/compile
no job-level target credential
no write-capable source GITHUB_TOKEN
all external Actions pinned
all three suites share target-safety helper
```

- [ ] **Step 3: Push all implementation commits and require ordinary branch/PR CI**

Preserve TDD commit boundaries for review.

- [ ] **Step 4: Verify one-time environment configuration before live qualification**

Maintainer evidence:

```text
github-e2e environment exists
Selected branches/tags allows master only
E2E_OWNER/E2E_REPO route to initialized disposable repo
E2E_REPO_ID equals resolved numeric ID
E2E_TOKEN mutable scope limited to target repo
actual default branch readable and differs from disposable branch
```

If tooling cannot inspect a setting, require explicit GitHub UI verification; do not infer.

- [ ] **Step 5: Merge only after review, then qualify exact final master SHA**

Require newest CI push run/current attempt for final master `M` completed/successful and artifact `github-e2e-input-M-<run>-<attempt>` exists/unexpired. Dispatch GitHub E2E Live selecting `master`.

Require current live workflow attempt:

```text
qualify executed + success
receipt github-e2e-target-<live-run>-<same-attempt> exists
receipt source SHA = M
receipt target ID = pinned E2E_REPO_ID
receipt CI producer run/attempt/artifact = authoritative current CI input
cleanup executed + success in same attempt
```

Do not dispatch Stable Release in Child B.

- [ ] **Step 6: Exercise cleanup-only rerun semantics only if naturally needed**

If cleanup fails, `Re-run failed jobs` may be used to safely remove residue. Confirm that attempt is **not** treated as release qualification because qualify/receipt were not recreated in that same attempt. Then use `Re-run all jobs` and require the new cohesive attempt to pass before qualification is restored.

- [ ] **Step 7: Record final handoff evidence**

Report exact implementation commit SHA, local commands actually run, GitHub CI run ID/attempt/result, live run ID/current attempt/job results, receipt identity, and manually verified environment settings. Never describe Child B as release-qualified without exact final-master cohesive-attempt evidence.

---

## Plan Self-Review Checklist

- Child B owns CI-produced E2E bundles but not Child A release-byte redesign.
- Fresh credentialed live runner executes no checkout/install/build/compile.
- Compile-only mode does not load `.env.github-e2e`.
- CI artifact contains exactly manifest + three bundles.
- Newest matching exact-SHA CI run/current attempt is authority; no historical-success fallback.
- Pinned `E2E_REPO_ID` mandatory; source ID rejected.
- Shared helper owns destructive-suite safety for all three scenario files.
- Default-ref capability precedes absent-ref interpretation.
- Same-attempt receipt persists before scenario mutation.
- Cleanup independently re-resolves configured route against pinned ID and does not depend on old-attempt artifacts.
- Live release qualification never mixes job/artifact evidence across attempts.
- Cleanup-only partial rerun is maintenance-only; Re-run all jobs restores qualification.
- Receipt is provenance data, not test-success proof.
- Source `GITHUB_TOKEN` remains read-only.
- External Actions are full-SHA pinned repository-wide.
- Local convenience remains usable with explicit expected target ID.
- Manual cleanup no longer has blind delete path.
- Final real-GitHub qualification occurs only on exact merged `master`; Stable Release is out of scope.