# Live GitHub E2E Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make release-qualifying real-GitHub E2E execute exact CI-produced bundles on a fresh runner against one pinned disposable repository, with target credentials isolated from build tooling and cleanup bound to durable repository identity evidence.

**Architecture:** Ordinary read-only `ci.yml` remains the only compiler of the three live-E2E bundles and uploads a strict provenance manifest with them. `github-e2e-live.yml` becomes a no-checkout/no-install/no-build consumer: it selects the newest exact-SHA CI producer, verifies and extracts that artifact, proves a pinned numeric target repository identity, persists a receipt before any target mutation, runs only the three fixed bundles serially, and cleans up using the highest valid persisted receipt rather than prior job outputs. All credentialed test suites share one target-safety helper; workflow cleanup uses equivalent fixed workflow-owned logic so privileged jobs never execute repository helper code outside the verified bundles.

**Tech Stack:** Node.js `v22.11.0`, TypeScript, ESM, esbuild, Node `node:test`, pnpm `9.12.3`, GitHub Actions, GitHub REST Git refs/Actions/artifact APIs, pinned external Actions.

**Spec:** `docs/superpowers/specs/2026-08-30-live-github-e2e-safety-design.md`

## Global Constraints

- Repository baseline for the approved design is `35e98cea924702293bde62d064a83d52eca6d898`; rebase/re-review if `master` materially changes before execution.
- Release-qualifying live E2E must run only for exact current `master` and must consume the newest matching exact-SHA ordinary CI `push` run; an older successful CI run is never fallback authority.
- CI is the sole compiler of release-qualifying live-E2E bundles. The credentialed live workflow must not checkout repository code, run pnpm/npm, install project dependencies, build, or compile.
- The live target credential must be step-scoped, never job-level state, and its mutable scope must be limited to the dedicated disposable target repository.
- `E2E_REPO_ID` is a mandatory maintainer-pinned numeric repository identity for Actions qualification. Owner/repository names are routing only.
- Release-qualifying branch name is exactly `obsidian-sync-e2e/run-${GITHUB_RUN_ID}` and must not equal the target's actual default branch.
- A readable initialized target default-branch Git ref is required before interpreting exact disposable-ref absence.
- Receipt persistence is a blocking prerequisite before any scenario target mutation.
- Cleanup must not depend on `needs.qualify.outputs` surviving a partial workflow rerun.
- The default source `GITHUB_TOKEN` remains read-only.
- Every external `uses:` reference in repository workflows is pinned to a verified full-length commit SHA.
- Do not change V4 publication-race retry classification in this child; Child C owns those changes.
- Do not change stable-release publication semantics beyond mechanical full-SHA action pinning; Child A owns release redesign.
- No new npm dependency is required for this child.

## File Structure

### New files

- `scripts/github-e2e-input.mjs` — one focused source-side library for deterministic bundle names/output and CI provenance-manifest hashing. It runs only in ordinary/local source contexts, never in the credentialed live workflow.
- `tests/github-e2e/support/target-safety.ts` — the single target identity/ref-capability/reset authority bundled into all credentialed E2E suites.
- `tests/feasibility/github-actions-pinning.test.mjs` — repository-wide external Action full-SHA contract.
- `tests/feasibility/github-e2e-input.test.mjs` — compile-output/manifest/CI-artifact contract.
- `tests/feasibility/github-e2e-target-safety.test.ts` — deterministic mocked GitHub REST tests for target safety.
- `tests/feasibility/github-e2e-suite-safety-contract.test.mjs` — proves all three credentialed suites consume the shared helper and no longer own ad-hoc reset logic.
- `tests/feasibility/github-e2e-live-workflow-contract.test.mjs` — static semantic/order contract for the no-checkout live workflow and durable receipt flow.

### Modified files

- `scripts/run-github-e2e.mjs` — use the shared bundle producer, support caller-owned compile output, skip `.env.github-e2e` entirely in compile-only mode, require expected target ID for credentialed local runs.
- `tests/feasibility/github-e2e-compile-cli.test.mjs` — expand compile-only regression coverage.
- `tests/github-e2e/v4-real-github-e2e.test.ts` — remove ad-hoc target/reset safety and use the shared helper.
- `tests/github-e2e/v4-copy-contract-github-e2e.test.ts` — same safety migration; preserve its current Normal-only CAS retry policy for Child C.
- `tests/github-e2e/v4-encrypted-external-mutation.test.ts` — same safety migration.
- `.github/workflows/ci.yml` — compile once into a fixed directory, write provenance manifest, upload release-qualifying E2E input only for `push` to `master`.
- `.github/workflows/github-e2e-live.yml` — replace source checkout/build execution with verified CI-artifact execution and receipt-bound cleanup.
- `.github/workflows/pre-release.yml` — mechanical full-SHA Action pinning only.
- `.github/workflows/release.yml` — mechanical full-SHA Action pinning only; no Child-A behavior changes here.
- `docs/github-e2e.md` — pinned target ID, environment branch restriction, CI-artifact flow, safe local/manual cleanup.
- `docs/releasing.md` — update only the live-E2E configuration/qualification portion so the release runbook no longer describes the old source-building live workflow.

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
- Produces: repository invariant `external uses => @<40 lowercase hex commit SHA>`; local `uses: ./...` remains allowed.

- [ ] **Step 1: Write the failing repository-wide pinning test**

```js
// tests/feasibility/github-actions-pinning.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workflowDir = resolve(".github/workflows");

function externalUse(line) {
  const match = line.match(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/u);
  if (!match) return null;
  if (match[1].startsWith("./")) return null;
  return match[1];
}

test("all external workflow actions are pinned to full commit SHAs", async () => {
  const names = (await readdir(workflowDir)).filter(name => /\.ya?ml$/u.test(name)).sort();
  const failures = [];
  for (const name of names) {
    const text = await readFile(resolve(workflowDir, name), "utf8");
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      const value = externalUse(line);
      if (!value) continue;
      if (!/^[^@\s]+@[0-9a-f]{40}$/u.test(value)) failures.push(`${name}:${index + 1}: ${value}`);
    }
  }
  assert.deepEqual(failures, []);
});
```

- [ ] **Step 2: Run the focused test and prove current mutable refs fail**

Run:

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-actions-pinning
```

Expected: FAIL and list current refs such as `actions/checkout@v6`, `actions/setup-node@v6`, `actions/upload-artifact@v4`, and `pnpm/action-setup@v4`.

- [ ] **Step 3: Replace the existing mutable refs with the already-verified commit SHAs**

Use these exact pins, retaining human-readable comments:

```yaml
uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
```

Do not otherwise redesign `.github/workflows/release.yml` or `.github/workflows/pre-release.yml` in this task.

- [ ] **Step 4: Run focused and full feasibility tests**

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
- Produces from `scripts/github-e2e-input.mjs`:

```js
export const GITHUB_E2E_BUNDLES = Object.freeze([
  "v4-real-github-e2e.test.mjs",
  "v4-copy-contract-github-e2e.test.mjs",
  "v4-encrypted-external-mutation.test.mjs",
]);

export async function compileGitHubE2EBundles({ root, outDir })
// => Promise<string[]> absolute output paths in the fixed order above

export async function writeGitHubE2EInputManifest({ outDir, env, nodeVersion })
// => Promise<object>; writes `${outDir}/github-e2e-input.json`
```

- `run-github-e2e.mjs` CLI adds:

```text
--out-dir=<path>             valid with --compile-only
--write-input-manifest       valid with --compile-only; requires GitHub producer env
```

- CI artifact name:

```text
github-e2e-input-${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

- Exact artifact logical entries:

```text
github-e2e-input.json
v4-real-github-e2e.test.mjs
v4-copy-contract-github-e2e.test.mjs
v4-encrypted-external-mutation.test.mjs
```

- [ ] **Step 1: Extend compile-only tests first**

Add regressions to `tests/feasibility/github-e2e-compile-cli.test.mjs`:

```js
test("compile-only ignores credential env-file loading and writes exactly three fixed bundles", async () => {
  const outDir = await mkdtemp(resolve(tmpdir(), "github-e2e-input-"));
  const env = { ...process.env, GITHUB_E2E_ENV_FILE: resolve(outDir, "intentionally-missing.env") };
  delete env.GITHUB_E2E_TOKEN;
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
});
```

Also pre-create a stale file in `outDir` and assert it is removed so CI cannot accidentally upload residue.

- [ ] **Step 2: Write failing manifest tests**

```js
// tests/feasibility/github-e2e-input.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { GITHUB_E2E_BUNDLES, writeGitHubE2EInputManifest } from "../../scripts/github-e2e-input.mjs";

test("E2E input manifest binds exact fixed bundles to CI producer identity", async () => {
  const outDir = await mkdtemp(resolve(tmpdir(), "e2e-manifest-"));
  for (const name of GITHUB_E2E_BUNDLES) await writeFile(resolve(outDir, name), `bundle:${name}\n`);
  await writeGitHubE2EInputManifest({
    outDir,
    env: {
      GITHUB_REPOSITORY_ID: "1282135059",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "1234",
      GITHUB_RUN_ATTEMPT: "2",
    },
    nodeVersion: "v22.11.0",
  });
  assert.deepEqual((await readdir(outDir)).sort(), ["github-e2e-input.json", ...GITHUB_E2E_BUNDLES].sort());
  const manifest = JSON.parse(await readFile(resolve(outDir, "github-e2e-input.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.repositoryId, "1282135059");
  assert.equal(manifest.commitSha, "a".repeat(40));
  assert.equal(manifest.workflowRunId, "1234");
  assert.equal(manifest.verifyExecutionAttempt, 2);
  assert.equal(manifest.nodeVersion, "v22.11.0");
  assert.deepEqual(manifest.bundles.map(item => item.name), GITHUB_E2E_BUNDLES);
  assert.ok(manifest.bundles.every(item => /^[0-9a-f]{64}$/u.test(item.sha256) && item.size > 0));
});
```

Add negative cases for missing producer env, non-40-hex SHA, zero/invalid attempt, missing bundle, and unexpected extra file when manifest is finalized.

- [ ] **Step 3: Run tests and prove they fail before the producer module/flags exist**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-compile-cli
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-input
```

Expected: FAIL because the fixed output/manifest contract is not implemented.

- [ ] **Step 4: Implement the focused producer module**

Core structure:

```js
// scripts/github-e2e-input.mjs
import { createHash } from "node:crypto";
import { readFile, readdir, rm, mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

export const GITHUB_E2E_ENTRY_POINTS = Object.freeze([
  "tests/github-e2e/v4-real-github-e2e.test.ts",
  "tests/github-e2e/v4-copy-contract-github-e2e.test.ts",
  "tests/github-e2e/v4-encrypted-external-mutation.test.ts",
]);
export const GITHUB_E2E_BUNDLES = Object.freeze(GITHUB_E2E_ENTRY_POINTS.map(path => path.split("/").at(-1).replace(/\.ts$/u, ".mjs")));

export async function compileGitHubE2EBundles({ root = process.cwd(), outDir }) {
  if (!outDir) throw new Error("GitHub E2E output directory is required.");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const outputs = [];
  for (let i = 0; i < GITHUB_E2E_ENTRY_POINTS.length; i++) {
    const outfile = resolve(outDir, GITHUB_E2E_BUNDLES[i]);
    await build({
      entryPoints: [resolve(root, GITHUB_E2E_ENTRY_POINTS[i])],
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

function required(env, name, pattern) {
  const value = env[name] ?? "";
  if (!pattern.test(value)) throw new Error(`Invalid GitHub E2E producer field: ${name}`);
  return value;
}

export async function writeGitHubE2EInputManifest({ outDir, env = process.env, nodeVersion = process.version }) {
  const repositoryId = required(env, "GITHUB_REPOSITORY_ID", /^[1-9][0-9]*$/u);
  const commitSha = required(env, "GITHUB_SHA", /^[0-9a-f]{40}$/u);
  const workflowRunId = required(env, "GITHUB_RUN_ID", /^[1-9][0-9]*$/u);
  const attemptText = required(env, "GITHUB_RUN_ATTEMPT", /^[1-9][0-9]*$/u);
  const entries = (await readdir(outDir)).sort();
  if (entries.join("\n") !== [...GITHUB_E2E_BUNDLES].sort().join("\n")) throw new Error("GitHub E2E input directory contains unexpected entries before manifest creation.");
  const bundles = [];
  for (const name of GITHUB_E2E_BUNDLES) {
    const file = resolve(outDir, name);
    const info = await stat(file);
    if (!info.isFile()) throw new Error(`GitHub E2E bundle is not a regular file: ${name}`);
    const bytes = await readFile(file);
    bundles.push({ name, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const manifest = {
    schemaVersion: 1,
    repositoryId,
    commitSha,
    workflowRunId,
    verifyExecutionAttempt: Number(attemptText),
    nodeVersion,
    bundles,
  };
  await writeFile(resolve(outDir, "github-e2e-input.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
```

Use IDs as validated decimal strings in manifests rather than depending on JavaScript integer precision.

- [ ] **Step 5: Refactor `run-github-e2e.mjs` without changing local credentialed semantics**

Determine compile mode **before** reading `.env.github-e2e`:

```js
const compileOnly = process.argv.includes("--compile-only") || process.env.GITHUB_E2E_COMPILE_ONLY === "1";
if (!compileOnly) loadEnvFile();
```

Parse `--out-dir=` and `--write-input-manifest`. Use `compileGitHubE2EBundles()` for both compile-only and local credentialed execution. When `--write-input-manifest` is present, call `writeGitHubE2EInputManifest()` after compilation. Do not load target credentials or target env files in compile-only mode.

- [ ] **Step 6: Make CI compile once and upload the E2E input only for master pushes**

Replace the existing compile command with:

```yaml
- name: Compile real GitHub E2E harness
  run: >-
    node scripts/run-github-e2e.mjs
    --compile-only
    --out-dir=.tmp/github-e2e-input
    --write-input-manifest
```

After package validation, add:

```yaml
- name: Upload release-qualifying GitHub E2E input
  if: github.event_name == 'push' && github.ref == 'refs/heads/master'
  uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  with:
    name: github-e2e-input-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}
    path: .tmp/github-e2e-input
    if-no-files-found: error
```

Keep the current ordinary plugin artifact behavior unchanged in Child B.

- [ ] **Step 7: Add CI workflow assertions to `github-e2e-input.test.mjs`**

Assert raw workflow semantics rather than whitespace snapshots:

```js
const ci = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
assert.match(ci, /--out-dir=\.tmp\/github-e2e-input/u);
assert.match(ci, /--write-input-manifest/u);
assert.match(ci, /github-e2e-input-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
assert.match(ci, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/master'/u);
```

- [ ] **Step 8: Run focused gates and compile the bundles**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-compile-cli
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-input
corepack pnpm test:github-e2e:compile
```

Expected: PASS without any GitHub E2E credential.

- [ ] **Step 9: Commit**

```bash
git add scripts/github-e2e-input.mjs scripts/run-github-e2e.mjs tests/feasibility/github-e2e-compile-cli.test.mjs tests/feasibility/github-e2e-input.test.mjs .github/workflows/ci.yml
git commit -m "test: produce provenance-bound github e2e bundles"
```

---

### Task 3: Build the Shared Target-Safety Authority with Mocked REST Tests

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

`resolveGitHubE2ETarget()` is non-destructive and proves repository ID, source inequality when supplied, actual default branch, required branch when supplied, branch != default, and readable default-branch Git ref.

`resetGitHubE2EDisposableBranch()` re-runs the full resolve/capability proof immediately before reset, treats absence as valid only after capability proof, handles a recognized concurrent already-absent result, and performs bounded post-delete capability + absence verification.

- [ ] **Step 1: Write the safety matrix before the helper exists**

Use a deterministic injected `fetch` fake. Required tests:

```ts
test("rejects case-different route that resolves to the source numeric repository ID", async () => {})
test("rejects configured route when resolved target ID differs from pinned ID", async () => {})
test("rejects the actual default branch even when its name is not main/master", async () => {})
test("rejects a branch that differs from required Actions branch", async () => {})
test("fails closed when repository metadata cannot be resolved", async () => {})
test("fails closed when the actual default-branch ref is unreadable", async () => {})
test("accepts exact disposable 404 only after default-ref capability succeeds", async () => {})
test("rejects arbitrary 422 as absence", async () => {})
test("accepts only exact recognized missing-reference validation after capability", async () => {})
test("accepts concurrent already-absent DELETE only after final capability and absence verification", async () => {})
test("fails when default-ref capability is lost after DELETE", async () => {})
test("requires expected numeric repository ID in credentialed environment parsing", () => {})
```

The fake should record method + URL order so tests assert capability reads occur before absence interpretation and again after deletion.

- [ ] **Step 2: Run the focused test and prove the module is missing**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-target-safety
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement strict environment parsing and ref encoding**

```ts
const FORBIDDEN_LOCAL_BRANCHES = new Set(["main", "master", "production", "prod", "release", "stable"])

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

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

Core rules:

```ts
const metadata = await expectJson<{
  id?: number
  full_name?: string
  default_branch?: string
}>(await request(repoUrl, { headers }), [200], "Cannot inspect GitHub E2E repository")

const repositoryId = String(metadata.id ?? "")
if (repositoryId !== input.expectedRepositoryId) throw new Error("GitHub E2E target repository ID does not match the pinned repository ID.")
if (input.sourceRepositoryId && repositoryId === input.sourceRepositoryId) throw new Error("GitHub E2E target repository must not be the source repository.")
if (!metadata.full_name || !metadata.default_branch) throw new Error("GitHub E2E repository metadata is incomplete.")
if (input.requiredBranch && input.branch !== input.requiredBranch) throw new Error("GitHub E2E branch does not match the required workflow branch.")
if (input.branch === metadata.default_branch) throw new Error("GITHUB_E2E_BRANCH must not be the repository default branch.")

const defaultRef = await expectJson<{ object?: { sha?: string } }>(
  await request(`${canonicalBase}/git/ref/heads/${encodeGitHubE2ERefPath(metadata.default_branch)}`, { headers }),
  [200],
  "Cannot prove Git-ref read capability on the target default branch",
)
if (!defaultRef.object?.sha) throw new Error("Target default-branch ref is missing its commit SHA.")
```

Never include the credential value in errors/log output.

- [ ] **Step 5: Implement exact absence classification and bounded reset**

Recognize absence only as:

```ts
async function isRecognizedMissingRef(response: Response): Promise<boolean> {
  if (response.status === 404) return true
  if (response.status !== 422) return false
  const text = await response.text()
  try { return (JSON.parse(text) as { message?: string }).message === "Reference does not exist" }
  catch { return false }
}
```

This helper is called only after default-ref capability is established. After a present exact ref, send `DELETE`; accept `204` or a recognized concurrent already-absent response, then re-read the actual default ref and poll the exact disposable ref up to 3 times. Any ambiguous response fails closed.

- [ ] **Step 6: Run focused tests**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-target-safety
```

Expected: PASS with no real network calls.

- [ ] **Step 7: Commit**

```bash
git add tests/github-e2e/support/target-safety.ts tests/feasibility/github-e2e-target-safety.test.ts
git commit -m "test: centralize github e2e target safety"
```

---

### Task 4: Migrate All Credentialed Suites and Local Runner to the Pinned-ID Contract

**Files:**
- Create: `tests/feasibility/github-e2e-suite-safety-contract.test.mjs`
- Modify: `tests/github-e2e/v4-real-github-e2e.test.ts`
- Modify: `tests/github-e2e/v4-copy-contract-github-e2e.test.ts`
- Modify: `tests/github-e2e/v4-encrypted-external-mutation.test.ts`
- Modify: `scripts/run-github-e2e.mjs`
- Modify: `tests/feasibility/github-e2e-compile-cli.test.mjs`

**Interfaces:**
- All three suites import `readGitHubE2ETargetEnvironment`, `resolveGitHubE2ETarget`, `resetGitHubE2EDisposableBranch`, and `encodeGitHubE2ERefPath` as needed.
- Credentialed local execution requires `GITHUB_E2E_EXPECTED_REPO_ID`.
- Actions execution additionally supplies `GITHUB_E2E_SOURCE_REPO_ID` and `GITHUB_E2E_REQUIRED_BRANCH`.
- Existing test scenario semantics and Child-C-owned retry logic remain unchanged.

- [ ] **Step 1: Write a static suite-consumer regression**

```js
// tests/feasibility/github-e2e-suite-safety-contract.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const suites = [
  "tests/github-e2e/v4-real-github-e2e.test.ts",
  "tests/github-e2e/v4-copy-contract-github-e2e.test.ts",
  "tests/github-e2e/v4-encrypted-external-mutation.test.ts",
];

test("every credentialed GitHub E2E suite delegates target reset safety", async () => {
  for (const file of suites) {
    const text = await readFile(resolve(file), "utf8");
    assert.match(text, /\.\/support\/target-safety/u, file);
    assert.match(text, /resetGitHubE2EDisposableBranch/u, file);
    assert.doesNotMatch(text, /async function deleteTestBranch/u, file);
    assert.doesNotMatch(text, /const forbiddenBranches/u, file);
  }
});
```

- [ ] **Step 2: Add a local-runner required-ID regression**

Extend `github-e2e-compile-cli.test.mjs` with a non-network validation case that provides owner/repo/branch/token but omits `GITHUB_E2E_EXPECTED_REPO_ID`. Assert exit status `2` and an error naming the missing expected ID before any bundle execution/network work.

- [ ] **Step 3: Run tests and prove they fail**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-suite-safety-contract
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-compile-cli
```

Expected: FAIL because suites still own reset logic and the runner does not require expected ID.

- [ ] **Step 4: Update the local runner required environment**

In non-compile mode:

```js
const required = [
  "GITHUB_E2E_OWNER",
  "GITHUB_E2E_REPO",
  "GITHUB_E2E_BRANCH",
  "GITHUB_E2E_TOKEN",
  "GITHUB_E2E_EXPECTED_REPO_ID",
];
```

Keep compile-only mode credential-free and keep the existing local convenience behavior of compiling then running serially.

- [ ] **Step 5: Migrate each suite to the shared helper**

Use this pattern at module setup:

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

Replace every scenario-start and `after()` branch reset with:

```ts
await resetGitHubE2EDisposableBranch(targetEnvironment)
```

Use `encodeGitHubE2ERefPath(github.branch)` anywhere external-interference code still needs the encoded ref path. Remove each suite's duplicate `forbiddenBranches`, env/config parser, ad-hoc `deleteTestBranch`, and duplicated absence loop.

Do **not** alter these Child-C-owned blocks in this task:

```text
v4-real-github-e2e Normal-only wrapper retry
v4-copy-contract-github-e2e Normal-only wrapper retry + conflictCopyStages.clear()
```

- [ ] **Step 6: Run deterministic compile and feasibility gates**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-suite-safety-contract
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-compile-cli
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-target-safety
corepack pnpm test:github-e2e:compile
```

Expected: PASS. No real target credential is required for these checks.

- [ ] **Step 7: Commit**

```bash
git add scripts/run-github-e2e.mjs tests/github-e2e tests/feasibility/github-e2e-suite-safety-contract.test.mjs tests/feasibility/github-e2e-compile-cli.test.mjs
git commit -m "test: enforce pinned live e2e repository identity"
```

---

### Task 5: Rewrite GitHub E2E Live as a Verified CI-Artifact Executor

**Files:**
- Create: `tests/feasibility/github-e2e-live-workflow-contract.test.mjs`
- Modify: `.github/workflows/github-e2e-live.yml`

**Interfaces:**
- Workflow environment variables/secrets:

```text
vars.E2E_OWNER
vars.E2E_REPO
vars.E2E_REPO_ID
secrets.E2E_TOKEN
```

- `qualify` consumes newest exact-SHA CI artifact and persists receipt artifact:

```text
github-e2e-target-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

whose sole file is `github-e2e-target.json`.

- `cleanup` discovers the highest valid receipt for the current workflow run via Actions artifacts; it does not use `needs.qualify.outputs` as target identity authority.

- [ ] **Step 1: Write the failing workflow contract before replacing the workflow**

```js
// tests/feasibility/github-e2e-live-workflow-contract.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const file = resolve(".github/workflows/github-e2e-live.yml");

test("live E2E workflow is a no-build verified-artifact executor", async () => {
  const text = await readFile(file, "utf8");
  assert.match(text, /actions:\s*read/u);
  assert.match(text, /contents:\s*read/u);
  assert.doesNotMatch(text, /actions\/checkout@/u);
  assert.doesNotMatch(text, /pnpm\/action-setup@/u);
  assert.doesNotMatch(text, /pnpm install|pnpm build|run-github-e2e\.mjs/u);
  assert.match(text, /github-e2e-input-/u);
  assert.match(text, /E2E_REPO_ID/u);
  assert.match(text, /github-e2e-target-/u);
  assert.match(text, /node --test --test-concurrency=1/u);
  assert.doesNotMatch(text, /needs\.qualify\.outputs/u);
  assert.doesNotMatch(text, /^ {4}env:/mu); // no job-level env blocks
});

test("receipt persistence precedes credentialed bundle execution", async () => {
  const text = await readFile(file, "utf8");
  const receipt = text.indexOf("Upload target/provenance receipt");
  const execute = text.indexOf("Run verified real GitHub E2E bundles");
  assert.ok(receipt >= 0 && execute > receipt);
});
```

Add assertions that both `qualify` and `cleanup` reference `environment: github-e2e`, `cleanup` uses `if: always()`, the branch literal contains `obsidian-sync-e2e/run-${{ github.run_id }}`, and the target secret is not mapped in any job-level `env:`.

- [ ] **Step 2: Run the focused test and prove the old workflow fails**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-live-workflow-contract
```

Expected: FAIL because current workflow checks out/builds and stores target credential at job scope.

- [ ] **Step 3: Replace workflow-level permissions and job shell structure**

Use:

```yaml
permissions:
  actions: read
  contents: read

concurrency:
  group: github-e2e-live
  cancel-in-progress: false
```

`qualify` and `cleanup` both use `environment: github-e2e`; neither job has a job-level `env:` block.

- [ ] **Step 4: Implement authoritative CI selection as fixed workflow-owned code**

The first `qualify` step uses only `${{ github.token }}` and must:

1. require `GITHUB_REF == refs/heads/master`,
2. GET source `git/ref/heads/master` and require its SHA equals `GITHUB_SHA`,
3. paginate all `ci.yml` runs filtered by exact SHA + `push`, then filter exact `head_branch=master` and choose newest by `created_at`, tie-breaking by numeric run ID,
4. require newest run `status=completed` and `conclusion=success`,
5. use that run's current `run_attempt` and attempt-specific jobs endpoint; require `verify` completed/successful,
6. locate exact unexpired artifact `github-e2e-input-${GITHUB_SHA}-${CI_RUN_ID}-${CI_ATTEMPT}` pagination-safely,
7. output CI run ID, attempt, artifact ID, artifact digest if present, and exact `.node-version` fetched from fixed source path at `GITHUB_SHA`.

The workflow-owned Node logic should use explicit pagination, e.g.:

```js
async function listAll(path) {
  const values = [];
  for (let page = 1; ; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await api(`${path}${separator}per_page=100&page=${page}`);
    const pageValues = response.workflow_runs ?? response.jobs ?? response.artifacts ?? [];
    values.push(...pageValues);
    if (pageValues.length < 100) return values;
  }
}
```

Do not use “first successful run found” logic.

- [ ] **Step 5: Download and validate the exact CI artifact before target credential exposure**

Use source read token to download the artifact by selected numeric artifact ID into a fresh directory. If the API exposes `digest: sha256:<hex>`, hash the downloaded archive and require equality.

Before extraction use standard-library archive inspection (Python `zipfile` is acceptable on the hosted runner) to reject:

```text
absolute paths
.. traversal
backslash path ambiguity
duplicate names
directories
symlink entries
extra/missing entries
```

Exact entries are the four files from Task 2. Parse `github-e2e-input.json` strictly and require repository ID, SHA, run ID, verify attempt, Node version, exact bundle names, sizes, and SHA-256 hashes. Manually write only validated regular-file bytes into a fresh directory; do not `extractall()` unvalidated input.

- [ ] **Step 6: Set up only the exact Node runtime needed to run already-verified bundles**

Use the full-SHA-pinned setup action:

```yaml
- name: Setup exact Node.js runtime
  uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
  with:
    node-version: ${{ steps.ci.outputs.node_version }}
```

No pnpm cache, install, source checkout, build, or compile is allowed.

- [ ] **Step 7: Resolve and prove the pinned target identity with step-scoped credential**

The guard step gets only:

```yaml
env:
  E2E_OWNER: ${{ vars.E2E_OWNER }}
  E2E_REPO: ${{ vars.E2E_REPO }}
  E2E_REPO_ID: ${{ vars.E2E_REPO_ID }}
  E2E_TOKEN: ${{ secrets.E2E_TOKEN }}
  E2E_BRANCH: obsidian-sync-e2e/run-${{ github.run_id }}
```

Fixed code must resolve target metadata and require:

```text
resolved ID == E2E_REPO_ID
resolved ID != GITHUB_REPOSITORY_ID
full_name exists
actual default_branch exists
E2E_BRANCH != actual default_branch
GET actual default-branch git ref == 200 with object SHA
```

Emit only non-secret canonical full name, repository ID, default branch, and target branch as step outputs.

- [ ] **Step 8: Persist the durable target/provenance receipt before scenario execution**

Without target token in the step environment, write exactly `github-e2e-target.json`:

```json
{
  "schemaVersion": 1,
  "sourceRepositoryId": "${GITHUB_REPOSITORY_ID}",
  "sourceCommitSha": "${GITHUB_SHA}",
  "workflowRunId": "${GITHUB_RUN_ID}",
  "qualifyExecutionAttempt": 1,
  "ciProducerRunId": "...",
  "ciVerifyExecutionAttempt": 1,
  "ciE2EArtifactId": "...",
  "ciE2EArtifactDigest": "sha256:... or null",
  "targetRepositoryId": "...",
  "targetFullName": "owner/repo",
  "targetDefaultBranch": "trunk",
  "targetBranch": "obsidian-sync-e2e/run-123"
}
```

Use actual runtime values, write atomically to a clean receipt directory, then upload as a **blocking** artifact:

```yaml
- name: Upload target/provenance receipt
  uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  with:
    name: github-e2e-target-${{ github.run_id }}-${{ github.run_attempt }}
    path: .tmp/github-e2e-receipt/github-e2e-target.json
    if-no-files-found: error
```

There must be no `continue-on-error`.

- [ ] **Step 9: Execute only the three verified bundles with step-scoped target credential**

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

The manifest cannot choose executable paths or arguments.

- [ ] **Step 10: Implement receipt-selected cleanup without `needs.qualify.outputs` authority**

`cleanup` runs `if: always()` on its own runner. First, with source read token only:

1. paginate artifacts for `GITHUB_RUN_ID`,
2. select names matching `^github-e2e-target-${GITHUB_RUN_ID}-([1-9][0-9]*)$`, highest attempt first,
3. download candidates until the highest valid receipt is found,
4. validate artifact digest when exposed, exact one-file archive shape, receipt schema/source repo/SHA/workflow run/attempt,
5. require receipt target ID equals current pinned `${{ vars.E2E_REPO_ID }}` and branch equals `obsidian-sync-e2e/run-${GITHUB_RUN_ID}`.

Then a separate cleanup step gets the target token and uses the receipt's **canonical `targetFullName`** for routing. It re-resolves metadata and requires the same repository ID, source inequality, branch != current default branch, and readable current default-branch ref before exact disposable-ref inspection/removal. A recognized already-absent result is accepted only inside that proven-capability window; final default-ref capability and exact branch absence are verified with bounded retries.

If no valid receipt exists, do not call the target mutation endpoint and fail the cleanup job.

- [ ] **Step 11: Run workflow/static feasibility tests**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-live-workflow-contract
node scripts/run-tests.mjs --tier=feasibility --filter=github-actions-pinning
corepack pnpm test:feasibility
corepack pnpm test:github-e2e:compile
```

Expected: PASS.

- [ ] **Step 12: Commit**

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
- One-time `github-e2e` environment configuration now requires:

```text
Variable: E2E_OWNER
Variable: E2E_REPO
Variable: E2E_REPO_ID
Secret:   E2E_TOKEN
Deployment branches/tags: Selected branches and tags -> branch master only; no tags
```

- Local credentialed execution now requires:

```text
GITHUB_E2E_EXPECTED_REPO_ID=<numeric target id>
```

- [ ] **Step 1: Rewrite the local/manual configuration section**

Document:

```text
GITHUB_E2E_OWNER=owner
GITHUB_E2E_REPO=dedicated-disposable-repository
GITHUB_E2E_EXPECTED_REPO_ID=123456789
GITHUB_E2E_BRANCH=local-v4-e2e
GITHUB_E2E_TOKEN=<repository-scoped credential>
```

State that release-qualifying configuration requires target-repository-only mutable scope; “prefer” is no longer sufficient wording.

Keep `pnpm test:github-e2e:quick` as the local convenience command and state explicitly that local convenience still compiles+runs in one process, while release-qualifying Actions deliberately consumes CI-precompiled bundles on a fresh runner.

- [ ] **Step 2: Rewrite GitHub Actions environment setup**

State exactly:

```text
Settings -> Environments -> github-e2e
Deployment branches and tags -> Selected branches and tags
Allowed branch -> master
No tags
```

Warn not to use `Protected branches only` while `master` has no protection rule.

Explain that `E2E_REPO_ID` is the pinned authority and owner/repo values are routing only.

- [ ] **Step 3: Replace the old blind cleanup snippet**

The runbook must require this invariant order before any manual deletion:

```text
known expected numeric target ID
-> resolve repository metadata
-> require resolved ID == expected ID
-> require branch is obsidian-sync-e2e/run-<RUN_ID>
-> require branch != actual default branch
-> read actual default-branch Git ref successfully
-> inspect exact disposable ref
-> delete only if present
-> read default-branch ref again
-> verify exact disposable ref absent
```

Do not leave a sample that treats arbitrary 404 as success before capability proof. The manual script may inline fixed Node code, but it must require `E2E_REPO_ID` and print canonical repository name/ID/default branch/target branch before deletion.

- [ ] **Step 4: Update only the Child-B portion of `docs/releasing.md`**

Change environment setup to include `E2E_REPO_ID` + selected branch `master`, and qualification flow to:

```text
ordinary CI on exact master succeeds
-> CI produces current github-e2e-input artifact
-> GitHub E2E Live consumes that exact current artifact
-> target/provenance receipt persists before target mutation
-> qualify succeeds
-> cleanup succeeds
```

Do not rewrite Stable Release build/publication behavior here; Child A will replace that section later.

- [ ] **Step 5: Run documentation-sensitive feasibility/static gates**

```bash
corepack pnpm test:feasibility
corepack pnpm test:github-e2e:compile
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/github-e2e.md docs/releasing.md
git commit -m "docs: harden live github e2e runbook"
```

---

### Task 7: Verify Child B End-to-End Before Handoff

**Files:**
- No planned source change. Fix only defects exposed by verification, each with its own failing regression and focused commit.

**Interfaces:**
- Produces: evidence that deterministic/local gates pass on the implementation branch and, after merge/configuration, one release-qualifying live run succeeds against exact current `master` and current CI E2E artifact.

- [ ] **Step 1: Attempt the complete deterministic local gate**

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

Expected: all PASS. If the local environment cannot install/run, record the exact failure honestly and continue with GitHub Actions after pushing; do not claim local success.

- [ ] **Step 2: Inspect the implementation diff for child-boundary violations**

Required checks:

```text
no Child-C typed-race implementation
no Child-A release publication redesign beyond action pins
no live workflow checkout/install/build/compile
no job-level target credential
no write-capable source GITHUB_TOKEN
all external Actions pinned
all three suites use target-safety helper
```

- [ ] **Step 3: Push every implementation commit to GitHub and require ordinary branch/PR CI**

Do not squash away the TDD commit boundaries before review. Use GitHub as source of truth.

- [ ] **Step 4: Before a real release-qualifying live run, verify the one-time environment configuration**

Maintainer evidence must confirm:

```text
github-e2e environment exists
Selected branches and tags allows master only
E2E_OWNER/E2E_REPO route to disposable initialized repository
E2E_REPO_ID equals that repository's numeric ID
E2E_TOKEN mutable scope is limited to that repository
actual default branch is readable and is not the disposable run branch
```

If current tooling cannot inspect a setting, do not infer it; require explicit maintainer verification in the GitHub UI/runbook.

- [ ] **Step 5: Merge only after review, then qualify the exact final master SHA**

After merge:

```text
current master SHA = M
newest CI push run for M = completed/success
CI artifact github-e2e-input-M-<run>-<attempt> exists and is unexpired
```

Dispatch **GitHub E2E Live** selecting `master`. Require:

```text
qualify = success
cleanup = success
receipt artifact exists for successful qualify attempt
receipt source SHA = M
receipt target repository ID = pinned E2E_REPO_ID
receipt CI producer run/attempt/artifact = current authoritative CI producer
```

Do not dispatch Stable Release as part of Child B verification.

- [ ] **Step 6: If cleanup alone fails, verify partial-rerun behavior**

Use GitHub's “Re-run failed jobs” only when appropriate. Expected contract:

```text
earlier successful qualify remains latest qualify execution
rerun cleanup can locate the earlier persisted receipt
cleanup succeeds without needs.qualify.outputs
```

If `qualify` is rerun, its newer execution becomes authority and must persist its own receipt before scenario mutation.

- [ ] **Step 7: Record final evidence in the implementation handoff**

Report exact commit SHA, local commands actually run, GitHub CI run ID/result, live E2E run ID/attempt/job results, and any operational setting that was manually verified. Never describe the child as release-qualified without exact final-master evidence.

---

## Plan Self-Review Checklist

Before execution begins, verify the plan against the approved spec:

- Child B owns CI-produced E2E bundles but not Child A release-byte artifact redesign.
- Fresh credentialed live runner executes no checkout/install/build/compile.
- Compile-only mode does not even load `.env.github-e2e`.
- CI artifact contains exactly manifest + three fixed bundles.
- Newest matching exact-SHA CI run is authority; no historical-success fallback.
- Pinned `E2E_REPO_ID` is mandatory and source repository ID is rejected.
- Shared helper owns destructive-suite safety for all three scenario files.
- Default-ref capability precedes absent-ref interpretation.
- Receipt persists before any scenario mutation.
- Cleanup routing survives partial rerun without `needs.qualify.outputs`.
- Live receipt is provenance/routing evidence, not proof of test success.
- Source `GITHUB_TOKEN` remains read-only.
- External Actions are full-SHA pinned repository-wide.
- Local convenience remains usable with an explicit expected target ID.
- Manual cleanup no longer has a blind delete path.
- Final real-GitHub qualification happens only on exact merged `master`; Stable Release is out of scope.
