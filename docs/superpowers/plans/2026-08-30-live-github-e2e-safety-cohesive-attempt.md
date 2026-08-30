# Live GitHub E2E Safety — Cohesive Attempt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute exact CI-produced real-GitHub E2E bundles on a fresh credentialed runner against one pinned disposable repository, with safe cleanup and release qualification bound to one current workflow attempt.

**Architecture:** Ordinary read-only CI is the only compiler of the three live E2E bundles. The live workflow selects the newest exact-SHA CI run/current attempt, verifies the artifact byte-for-byte, proves a pinned numeric target repository identity, persists a same-attempt provenance receipt before target mutation, executes only the three verified bundles, and independently re-proves the pinned target before cleanup. A release-qualifying live run never mixes evidence across attempts: current attempt must contain `qualify` success, same-attempt receipt, and `cleanup` success.

**Tech Stack:** Node.js `v22.11.0`, TypeScript, ESM, esbuild, Node `node:test`, pnpm `9.12.3`, GitHub Actions, GitHub REST APIs, Python standard-library `zipfile` for safe archive inspection, pinned external Actions.

**Spec:** `docs/superpowers/specs/2026-08-30-live-github-e2e-safety-design.md`

## Global Constraints

- Baseline is `35e98cea924702293bde62d064a83d52eca6d898`; if `master` materially changes before execution, rebase and re-review affected tasks.
- CI is the sole compiler of release-qualifying E2E bundles.
- Live `qualify` has no checkout, pnpm/npm install, project build, or compile step.
- Source `GITHUB_TOKEN` remains `actions: read`, `contents: read` only.
- `E2E_TOKEN` is step-scoped and mutable only on the dedicated disposable target repository.
- `E2E_REPO_ID` is mandatory pinned identity. `E2E_OWNER/E2E_REPO` are routing only.
- Actions branch is exactly `obsidian-sync-e2e/run-${GITHUB_RUN_ID}`.
- Default-branch Git-ref readability must be proven before exact disposable-ref absence has meaning.
- Receipt upload must succeed before scenario mutation.
- Current/latest live workflow attempt must contain successful `qualify`, successful `cleanup`, and same-attempt receipt to qualify a release.
- `Re-run failed jobs` may repair cleanup residue but does not restore qualification; use `Re-run all jobs` for a cohesive qualifying attempt.
- No new npm dependency.
- Child C retry semantics and Child A stable-publication redesign are out of scope.

## File Map

**Create**
- `scripts/github-e2e-input.mjs` — deterministic bundle producer + manifest writer.
- `tests/github-e2e/support/target-safety.ts` — shared target identity/reset authority.
- `tests/feasibility/github-actions-pinning.test.mjs`
- `tests/feasibility/github-e2e-input.test.mjs`
- `tests/feasibility/github-e2e-target-safety.test.ts`
- `tests/feasibility/github-e2e-suite-safety-contract.test.mjs`
- `tests/feasibility/github-e2e-live-workflow-contract.test.mjs`

**Modify**
- `scripts/run-github-e2e.mjs`
- `tests/feasibility/github-e2e-compile-cli.test.mjs`
- `tests/github-e2e/v4-real-github-e2e.test.ts`
- `tests/github-e2e/v4-copy-contract-github-e2e.test.ts`
- `tests/github-e2e/v4-encrypted-external-mutation.test.ts`
- `.github/workflows/ci.yml`
- `.github/workflows/github-e2e-live.yml`
- `.github/workflows/pre-release.yml`
- `.github/workflows/release.yml`
- `docs/github-e2e.md`
- `docs/releasing.md`

---

### Task 1: Pin External Actions and Lock the Contract

**Files:**
- Create: `tests/feasibility/github-actions-pinning.test.mjs`
- Modify: all four `.github/workflows/*.yml`

**Interfaces:**
- Produces invariant: every external `uses:` value is `owner/repo@<40 lowercase hex>`.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workflowDir = resolve(".github/workflows");

test("external workflow actions are full-SHA pinned", async () => {
  const failures = [];
  for (const name of (await readdir(workflowDir)).filter(name => /\.ya?ml$/u.test(name)).sort()) {
    const text = await readFile(resolve(workflowDir, name), "utf8");
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      const match = line.match(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/u);
      if (!match || match[1].startsWith("./")) continue;
      if (!/^[^@\s]+@[0-9a-f]{40}$/u.test(match[1])) failures.push(`${name}:${index + 1}: ${match[1]}`);
    }
  }
  assert.deepEqual(failures, []);
});
```

- [ ] **Step 2: Prove current refs fail**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-actions-pinning
```

Expected: FAIL on current `@v4`/`@v6` references.

- [ ] **Step 3: Pin the verified commits**

```yaml
uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
```

Only replace refs in `pre-release.yml` and `release.yml`; do not redesign those workflows in Child B.

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

### Task 2: Produce Exact CI E2E Input

**Files:**
- Create: `scripts/github-e2e-input.mjs`
- Create: `tests/feasibility/github-e2e-input.test.mjs`
- Modify: `scripts/run-github-e2e.mjs`
- Modify: `tests/feasibility/github-e2e-compile-cli.test.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

```js
export const GITHUB_E2E_BUNDLES
export async function compileGitHubE2EBundles({ root, outDir })
export async function writeGitHubE2EInputManifest({ outDir, env, nodeVersion })
```

Artifact name:

```text
github-e2e-input-${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

Exact entries: `github-e2e-input.json` + three fixed `.mjs` bundles.

- [ ] **Step 1: Expand compile-only regression before implementation**

Add to `github-e2e-compile-cli.test.mjs`:

```js
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const outDir = await mkdtemp(resolve(tmpdir(), "github-e2e-compile-"));
await writeFile(resolve(outDir, "stale.txt"), "stale\n");
const env = { ...process.env, GITHUB_E2E_ENV_FILE: resolve(outDir, "missing.env") };
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
```

This specifically proves compile-only skips `.env.github-e2e` loading even when `GITHUB_E2E_ENV_FILE` points to a missing file.

- [ ] **Step 2: Write manifest tests first**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { GITHUB_E2E_BUNDLES, writeGitHubE2EInputManifest } from "../../scripts/github-e2e-input.mjs";

test("manifest binds fixed bundles to exact CI run attempt", async () => {
  const outDir = await mkdtemp(resolve(tmpdir(), "github-e2e-manifest-"));
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
  const manifest = JSON.parse(await readFile(resolve(outDir, "github-e2e-input.json"), "utf8"));
  assert.deepEqual({
    schemaVersion: manifest.schemaVersion,
    repositoryId: manifest.repositoryId,
    commitSha: manifest.commitSha,
    workflowRunId: manifest.workflowRunId,
    workflowRunAttempt: manifest.workflowRunAttempt,
    nodeVersion: manifest.nodeVersion,
  }, {
    schemaVersion: 1,
    repositoryId: "1282135059",
    commitSha: "a".repeat(40),
    workflowRunId: "1234",
    workflowRunAttempt: 2,
    nodeVersion: "v22.11.0",
  });
  assert.deepEqual(manifest.bundles.map(item => item.name), GITHUB_E2E_BUNDLES);
  assert.ok(manifest.bundles.every(item => Number.isSafeInteger(item.size) && item.size > 0 && /^[0-9a-f]{64}$/u.test(item.sha256)));
});
```

Add negative tests for missing/invalid repo ID, SHA, run ID, attempt, bundle, and unexpected extra entry.

- [ ] **Step 3: Run tests to verify failure**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-compile-cli
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-input
```

Expected: FAIL because module/flags do not exist.

- [ ] **Step 4: Implement `scripts/github-e2e-input.mjs`**

```js
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

export const GITHUB_E2E_ENTRY_POINTS = Object.freeze([
  "tests/github-e2e/v4-real-github-e2e.test.ts",
  "tests/github-e2e/v4-copy-contract-github-e2e.test.ts",
  "tests/github-e2e/v4-encrypted-external-mutation.test.ts",
]);
export const GITHUB_E2E_BUNDLES = Object.freeze(GITHUB_E2E_ENTRY_POINTS.map(value => value.split("/").at(-1).replace(/\.ts$/u, ".mjs")));

function required(env, name, pattern) {
  const value = env[name] ?? "";
  if (!pattern.test(value)) throw new Error(`Invalid GitHub E2E producer field: ${name}`);
  return value;
}

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
  const repositoryId = required(env, "GITHUB_REPOSITORY_ID", /^[1-9][0-9]*$/u);
  const commitSha = required(env, "GITHUB_SHA", /^[0-9a-f]{40}$/u);
  const workflowRunId = required(env, "GITHUB_RUN_ID", /^[1-9][0-9]*$/u);
  const attemptText = required(env, "GITHUB_RUN_ATTEMPT", /^[1-9][0-9]*$/u);
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(nodeVersion)) throw new Error("Invalid GitHub E2E producer Node version.");
  const existing = (await readdir(outDir)).sort();
  const expected = [...GITHUB_E2E_BUNDLES].sort();
  if (existing.length !== expected.length || existing.some((value, index) => value !== expected[index])) {
    throw new Error("GitHub E2E input directory contains unexpected entries before manifest creation.");
  }
  const bundles = [];
  for (const name of GITHUB_E2E_BUNDLES) {
    const file = resolve(outDir, name);
    const info = await stat(file);
    if (!info.isFile()) throw new Error(`GitHub E2E bundle is not a regular file: ${name}`);
    const bytes = await readFile(file);
    if (bytes.byteLength === 0) throw new Error(`GitHub E2E bundle is empty: ${name}`);
    bundles.push({
      name,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const manifest = {
    schemaVersion: 1,
    repositoryId,
    commitSha,
    workflowRunId,
    workflowRunAttempt: Number(attemptText),
    nodeVersion,
    bundles,
  };
  await writeFile(resolve(outDir, "github-e2e-input.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
```

- [ ] **Step 5: Refactor runner CLI**

At module startup:

```js
const compileOnly = process.argv.includes("--compile-only") || process.env.GITHUB_E2E_COMPILE_ONLY === "1";
if (!compileOnly) loadEnvFile();

function optionValue(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(value => value.startsWith(prefix))?.slice(prefix.length);
}

const requestedOutDir = optionValue("out-dir");
const writeInputManifest = process.argv.includes("--write-input-manifest");
```

Call `compileGitHubE2EBundles({ root, outDir })`; compile-only with explicit output leaves the files in that directory. When `--write-input-manifest` is present, call `writeGitHubE2EInputManifest({ outDir })` after compile. Non-compile local mode retains serial `node --test` execution and may keep its temporary directory behavior.

- [ ] **Step 6: Modify CI to compile once and upload only for master push**

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

Keep the current plugin artifact untouched.

- [ ] **Step 7: Add CI text assertions**

```js
const ci = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
assert.match(ci, /--out-dir=\.tmp\/github-e2e-input/u);
assert.match(ci, /--write-input-manifest/u);
assert.match(ci, /github-e2e-input-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
assert.match(ci, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/master'/u);
```

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

### Task 3: Centralize Target Safety

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

- [ ] **Step 1: Write mocked safety matrix**

Cover pinned-ID mismatch, source-ID equality including case-different route, actual default branch, required Actions branch mismatch, metadata failure, default-ref unreadability, exact 404 only after capability, arbitrary 422 rejection, exact `Reference does not exist` recognition, concurrent already-absent DELETE, post-delete capability loss, and missing/invalid expected ID.

Use a fake like:

```ts
function scriptedFetch(steps: Array<{ method?: string; path: string; status: number; body?: unknown }>): GitHubE2EFetch {
  let index = 0
  return async (url, init = {}) => {
    const step = steps[index++]
    assert.ok(step, `unexpected request ${init.method ?? "GET"} ${url}`)
    assert.equal((init.method ?? "GET").toUpperCase(), step.method ?? "GET")
    assert.equal(new URL(url).pathname, step.path)
    return new Response(step.body === undefined ? "" : JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json" },
    })
  }
}
```

- [ ] **Step 2: Prove module missing**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-target-safety
```

- [ ] **Step 3: Implement environment/ref helpers**

```ts
const API = "https://api.github.com"
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

- [ ] **Step 4: Implement strict request/metadata resolution**

```ts
function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2026-03-10",
  }
}

async function json<T>(response: Response, statuses: readonly number[], action: string): Promise<T> {
  const text = await response.text()
  if (!statuses.includes(response.status)) throw new Error(`${action}: HTTP ${response.status} ${text}`)
  return (text ? JSON.parse(text) : {}) as T
}

export async function resolveGitHubE2ETarget(input: GitHubE2ETargetEnvironment, request: GitHubE2EFetch = fetch): Promise<ResolvedGitHubE2ETarget> {
  const route = `${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`
  const metadata = await json<{ id?: number; full_name?: string; default_branch?: string }>(
    await request(`${API}/repos/${route}`, { headers: headers(input.token) }),
    [200],
    "Cannot inspect GitHub E2E repository",
  )
  const repositoryId = String(metadata.id ?? "")
  if (repositoryId !== input.expectedRepositoryId) throw new Error("GitHub E2E target repository ID does not match the pinned repository ID.")
  if (input.sourceRepositoryId && repositoryId === input.sourceRepositoryId) throw new Error("GitHub E2E target repository must not be the source repository.")
  if (!metadata.full_name || !metadata.default_branch) throw new Error("GitHub E2E repository metadata is incomplete.")
  if (input.requiredBranch && input.branch !== input.requiredBranch) throw new Error("GitHub E2E branch does not match the required workflow branch.")
  if (input.branch === metadata.default_branch) throw new Error("GITHUB_E2E_BRANCH must not be the repository default branch.")
  const [owner, repo, ...extra] = metadata.full_name.split("/")
  if (!owner || !repo || extra.length > 0) throw new Error("GitHub E2E repository full_name is invalid.")
  const canonicalBase = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const defaultRef = await json<{ object?: { sha?: string } }>(
    await request(`${canonicalBase}/git/ref/heads/${encodeGitHubE2ERefPath(metadata.default_branch)}`, { headers: headers(input.token) }),
    [200],
    "Cannot prove Git-ref read capability on target default branch",
  )
  if (!defaultRef.object?.sha) throw new Error("Target default-branch ref is missing its commit SHA.")
  return {
    config: { owner, repo, branch: input.branch, token: input.token },
    repositoryId,
    fullName: metadata.full_name,
    defaultBranch: metadata.default_branch,
    defaultBranchSha: defaultRef.object.sha,
  }
}
```

- [ ] **Step 5: Implement exact absence + reset**

```ts
async function recognizedMissingRef(response: Response): Promise<boolean> {
  if (response.status === 404) { await response.arrayBuffer().catch(() => undefined); return true }
  const text = await response.text()
  if (response.status !== 422) return false
  try { return (JSON.parse(text) as { message?: string }).message === "Reference does not exist" }
  catch { return false }
}

export async function resetGitHubE2EDisposableBranch(input: GitHubE2ETargetEnvironment, request: GitHubE2EFetch = fetch): Promise<ResolvedGitHubE2ETarget> {
  const target = await resolveGitHubE2ETarget(input, request)
  const base = `${API}/repos/${encodeURIComponent(target.config.owner)}/${encodeURIComponent(target.config.repo)}`
  const exact = `${base}/git/refs/heads/${encodeGitHubE2ERefPath(target.config.branch)}`
  const auth = headers(input.token)
  const before = await request(exact, { headers: auth })
  if (await recognizedMissingRef(before)) return target
  if (before.status !== 200) throw new Error(`Cannot inspect GitHub E2E disposable ref: HTTP ${before.status}`)
  await before.arrayBuffer().catch(() => undefined)
  const deleted = await request(exact, { method: "DELETE", headers: auth })
  if (deleted.status !== 204 && !(await recognizedMissingRef(deleted))) throw new Error(`Cannot remove GitHub E2E disposable ref: HTTP ${deleted.status}`)
  for (let attempt = 1; attempt <= 3; attempt++) {
    await resolveGitHubE2ETarget(input, request) // re-proves current default-ref capability
    const verify = await request(exact, { headers: auth })
    if (await recognizedMissingRef(verify)) return target
    if (verify.status !== 200) throw new Error(`Cannot verify GitHub E2E disposable ref absence: HTTP ${verify.status}`)
    await verify.arrayBuffer().catch(() => undefined)
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 500))
  }
  throw new Error(`GitHub E2E disposable branch still exists: ${input.branch}`)
}
```

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

### Task 4: Migrate the Three Suites and Local Runner

**Files:**
- Create: `tests/feasibility/github-e2e-suite-safety-contract.test.mjs`
- Modify: three `tests/github-e2e/*.test.ts`
- Modify: `scripts/run-github-e2e.mjs`
- Modify: `tests/feasibility/github-e2e-compile-cli.test.mjs`

**Interfaces:**
- Credentialed env now requires `GITHUB_E2E_EXPECTED_REPO_ID`.
- Actions additionally sets `GITHUB_E2E_SOURCE_REPO_ID` and `GITHUB_E2E_REQUIRED_BRANCH`.

- [ ] **Step 1: Write suite-consumer test**

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

- [ ] **Step 2: Add local missing-ID test**

Spawn non-compile runner with owner/repo/branch/token but no expected ID; require status 2 and `GITHUB_E2E_EXPECTED_REPO_ID` in stderr before any network work.

- [ ] **Step 3: Prove failure**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-suite-safety-contract
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-compile-cli
```

- [ ] **Step 4: Update runner required env**

```js
const required = [
  "GITHUB_E2E_OWNER",
  "GITHUB_E2E_REPO",
  "GITHUB_E2E_BRANCH",
  "GITHUB_E2E_TOKEN",
  "GITHUB_E2E_EXPECTED_REPO_ID",
];
```

- [ ] **Step 5: Migrate each suite**

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

Replace every scenario-start and `after()` reset with:

```ts
await resetGitHubE2EDisposableBranch(targetEnvironment)
```

Use shared ref encoder where external-interference code needs the branch URL. Remove duplicate env/forbidden/delete helpers. Do not alter existing main/copy CAS retry logic in this child.

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

### Task 5: Rewrite Live Workflow Around Verified CI Artifact

**Files:**
- Create: `tests/feasibility/github-e2e-live-workflow-contract.test.mjs`
- Modify: `.github/workflows/github-e2e-live.yml`

**Interfaces:**

```text
vars.E2E_OWNER
vars.E2E_REPO
vars.E2E_REPO_ID
secrets.E2E_TOKEN
```

Same-attempt receipt:

```text
github-e2e-target-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

- [ ] **Step 1: Write failing static workflow contract**

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
assert.doesNotMatch(text, /^ {4}env:/mu);
const receipt = text.indexOf("Upload same-attempt qualification receipt");
const execute = text.indexOf("Run verified real GitHub E2E bundles");
assert.ok(receipt >= 0 && execute > receipt);
```

Also assert two `environment: github-e2e` occurrences, `cleanup` has `if: always()`, and workflow text contains a comment/step name making cleanup-only rerun non-qualifying semantics explicit.

- [ ] **Step 2: Prove old workflow fails**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-live-workflow-contract
```

- [ ] **Step 3: Establish read-only/no-build workflow skeleton**

```yaml
name: GitHub E2E Live
on:
  workflow_dispatch:
permissions:
  actions: read
  contents: read
concurrency:
  group: github-e2e-live
  cancel-in-progress: false
```

Both jobs reference `environment: github-e2e`; neither has job-level `env:`.

- [ ] **Step 4: Implement newest CI current-attempt selector**

Use a fixed inline Node script with source `GITHUB_TOKEN`. Implement these functions exactly:

```js
const headers = {
  Authorization: `Bearer ${process.env.GH_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2026-03-10",
};
async function api(path) {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, { headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub API ${path}: HTTP ${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}
async function listAll(path, key) {
  const values = [];
  for (let page = 1; ; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const payload = await api(`${path}${separator}per_page=100&page=${page}`);
    const batch = payload[key] ?? [];
    values.push(...batch);
    if (batch.length < 100) return values;
  }
}
function newest(left, right) {
  const time = Date.parse(right.created_at) - Date.parse(left.created_at);
  if (time) return time;
  const a = BigInt(String(left.id));
  const b = BigInt(String(right.id));
  return a === b ? 0 : b > a ? 1 : -1;
}
```

Then:

```js
const master = await api("/git/ref/heads/master");
if (process.env.GITHUB_REF !== "refs/heads/master" || master.object?.sha !== process.env.GITHUB_SHA) throw new Error("Live qualification source is not exact current master.");
const runs = (await listAll(`/actions/workflows/ci.yml/runs?head_sha=${process.env.GITHUB_SHA}&event=push`, "workflow_runs"))
  .filter(run => run.head_branch === "master" && run.head_sha === process.env.GITHUB_SHA)
  .sort(newest);
const run = runs[0];
if (!run || run.status !== "completed" || run.conclusion !== "success") throw new Error("Newest exact-SHA CI run is not successful.");
const attempt = Number(run.run_attempt);
if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Invalid CI run attempt.");
const jobs = await listAll(`/actions/runs/${run.id}/attempts/${attempt}/jobs`, "jobs");
const verify = jobs.find(job => job.name === "verify");
if (!verify || verify.status !== "completed" || verify.conclusion !== "success") throw new Error("CI verify job is not successful in the current run attempt.");
const artifactName = `github-e2e-input-${process.env.GITHUB_SHA}-${run.id}-${attempt}`;
const artifacts = await listAll(`/actions/runs/${run.id}/artifacts`, "artifacts");
const matches = artifacts.filter(item => item.name === artifactName && item.expired === false);
if (matches.length !== 1) throw new Error(`Expected exactly one current CI E2E artifact: ${artifactName}`);
```

Fetch exact `.node-version` at `GITHUB_SHA`, decode base64, trim, and require `^v\d+\.\d+\.\d+$`. Write run ID/attempt/artifact ID/digest/node version to `$GITHUB_OUTPUT`.

- [ ] **Step 5: Download and validate artifact before target secret exposure**

Download REST endpoint `/actions/artifacts/<id>/zip` following redirect with source read token. If REST exposes `sha256:<hex>`, compute SHA-256 of downloaded ZIP and require equality.

Use Python standard library for safe inspection. Core validation:

```py
from pathlib import PurePosixPath
from zipfile import ZipFile

EXPECTED = {
    "github-e2e-input.json",
    "v4-real-github-e2e.test.mjs",
    "v4-copy-contract-github-e2e.test.mjs",
    "v4-encrypted-external-mutation.test.mjs",
}
with ZipFile(archive) as zf:
    infos = zf.infolist()
    names = [info.filename for info in infos]
    if len(names) != len(set(names)) or set(names) != EXPECTED:
        raise SystemExit("unexpected GitHub E2E artifact entries")
    for info in infos:
        path = PurePosixPath(info.filename)
        mode = (info.external_attr >> 16) & 0o170000
        if path.is_absolute() or ".." in path.parts or "\\" in info.filename or info.is_dir() or mode == 0o120000:
            raise SystemExit(f"unsafe GitHub E2E artifact entry: {info.filename}")
```

Parse manifest with a duplicate-key rejecting `object_pairs_hook`, require exact schema/source repo ID/SHA/run ID/current attempt/Node version/bundle array, then write only verified bundle bytes to fresh `.tmp/github-e2e-verified` after recomputing each size/SHA-256.

- [ ] **Step 6: Set up exact Node runtime only**

```yaml
- name: Setup exact Node.js runtime
  uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
  with:
    node-version: ${{ steps.ci.outputs.node_version }}
```

No cache/pnpm/install.

- [ ] **Step 7: Prove pinned target identity with target secret scoped to one step**

The step env is exactly routing vars, pinned ID, run-derived branch, and secret. Its inline Node code must GET `/repos/{owner}/{repo}`, require ID == pinned ID and != source repository ID, require full_name/default_branch, reject default branch, then GET canonical default-branch Git ref and require object SHA. Write canonical owner/repo/ID/default/branch to step outputs. Never print token.

- [ ] **Step 8: Persist same-attempt receipt before scenario mutation**

Write `github-e2e-target.json` from trusted workflow context + CI step outputs + target step outputs, with:

```text
schemaVersion=1
sourceRepositoryId
sourceCommitSha
workflowRunId
workflowRunAttempt
ciProducerRunId
ciProducerRunAttempt
ciE2EArtifactId
ciE2EArtifactDigest|null
targetRepositoryId
targetFullName
targetDefaultBranch
targetBranch
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

- [ ] **Step 9: Execute only fixed bundles with target secret**

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

- [ ] **Step 10: Implement cleanup as independent pinned-ID proof**

`cleanup` uses `if: always()` and the same environment. Its only credentialed step gets current route vars + pinned ID + secret + derived branch. Reuse the exact logical sequence from target-safety helper in workflow-owned inline Node:

```text
GET current configured route metadata
require resolved ID == E2E_REPO_ID
require resolved ID != GITHUB_REPOSITORY_ID
require branch == obsidian-sync-e2e/run-${GITHUB_RUN_ID}
require branch != current default_branch
GET current default-branch ref = 200 + SHA
GET exact disposable ref
  recognized absent -> success
  200 -> DELETE exact ref
  other -> fail
DELETE 204 or recognized concurrent absence only
GET current default-branch ref = 200 + SHA again
GET exact disposable ref with <=3 bounded checks
  recognized absent -> success
  200 after final check -> fail
  other -> fail
```

No receipt download and no `needs.qualify.outputs` identity dependence. If route changed to a different ID, mutate nothing.

- [ ] **Step 11: Encode cohesive-attempt contract in static tests/docs markers**

The workflow contract should assert same-attempt receipt name includes `github.run_attempt`. Add a workflow comment near cleanup:

```yaml
# A cleanup-only rerun may remove residue but is not release qualification;
# release qualification requires qualify + receipt + cleanup in one current attempt.
```

Child A will enforce this via attempt-specific job/receipt selection.

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

### Task 6: Update Maintainer Flow and Safe Manual Cleanup

**Files:**
- Modify: `docs/github-e2e.md`
- Modify: `docs/releasing.md`

**Interfaces:**

```text
Environment variable: E2E_OWNER
Environment variable: E2E_REPO
Environment variable: E2E_REPO_ID
Environment secret:   E2E_TOKEN
Deployment policy: Selected branches/tags -> master only, no tags
```

Local adds `GITHUB_E2E_EXPECTED_REPO_ID`.

- [ ] **Step 1: Update local configuration**

Document all five local env values; expected numeric ID is mandatory. State local convenience still compiles+runs in one process, while release-qualifying Actions runs CI-produced bundles on a fresh runner.

- [ ] **Step 2: Update environment setup**

Document `Settings -> Environments -> github-e2e -> Selected branches and tags -> master`. Warn not to choose `Protected branches only` while master is unprotected.

- [ ] **Step 3: Replace blind cleanup recipe**

Manual recipe must resolve current configured route, verify known expected numeric ID, verify run-derived branch != actual default, read default ref successfully, inspect/remove exact disposable ref, re-read default ref, and confirm exact absence. Do not accept arbitrary 404 before capability proof.

- [ ] **Step 4: Document rerun semantics**

```text
cleanup-only failure -> Re-run failed jobs is allowed to clean residue
that attempt is maintenance-only, not release qualification
for release qualification -> Re-run all jobs
new current attempt must run qualify, create receipt, execute bundles, and cleanup successfully
```

- [ ] **Step 5: Update only Child-B portion of releasing runbook**

Explain CI artifact -> live current attempt -> same-attempt receipt -> qualify+cleanup. Leave Stable Release internals for Child A.

- [ ] **Step 6: Verify**

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

### Task 7: Final Verification and Exact-Master Qualification

**Files:**
- No planned source changes. Any discovered defect gets a failing regression and separate fix commit.

**Interfaces:**
- Produces exact local/CI/live evidence; does not create Stable Release.

- [ ] **Step 1: Attempt full deterministic local gate**

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

Record any environmental inability honestly.

- [ ] **Step 2: Review diff boundaries**

Require no Child-C typed-race implementation, no Child-A release redesign except action pins, no live checkout/install/build/compile, no job-level target credential, no write-capable source token, all external Actions pinned, all three suites using shared target helper.

- [ ] **Step 3: Push commits and require branch/PR CI**

Keep TDD commit boundaries visible.

- [ ] **Step 4: Verify one-time GitHub environment configuration**

Confirm in GitHub UI when connector cannot prove settings: `github-e2e` environment, selected branch `master`, disposable route, pinned numeric ID, target-only credential, initialized readable non-disposable default branch.

- [ ] **Step 5: Merge after review and qualify final master**

For final master `M`, require newest CI push run/current attempt completed/successful and current E2E artifact exists/unexpired. Dispatch GitHub E2E Live on `master`.

Require current live attempt:

```text
qualify executed + success
receipt github-e2e-target-<run>-<current-attempt> exists
receipt SHA = M
receipt target ID = pinned E2E_REPO_ID
receipt CI run/attempt/artifact = current authoritative CI input
cleanup executed + success in same attempt
```

Do not dispatch Stable Release.

- [ ] **Step 6: If cleanup fails, validate maintenance-only partial rerun**

`Re-run failed jobs` may clean residue. Verify this partial attempt is not presented as release qualification. Then use `Re-run all jobs` and require the new current attempt to satisfy all cohesive-attempt conditions.

- [ ] **Step 7: Record handoff evidence**

Report exact implementation commit SHA, local commands actually executed, CI run ID/attempt/result, live run ID/current attempt/job results, receipt identity, and any manually verified environment settings.

---

## Self-Review Coverage

- Spec Section 1–3: Tasks 2 and 5.
- Pinned identity/environment: Tasks 3–6.
- Action pinning: Task 1.
- Shared destructive safety/ref capability: Tasks 3–5.
- Same-attempt receipt: Task 5.
- Cohesive attempt qualification and rerun UX: Tasks 5–7.
- Local/manual safety: Tasks 4 and 6.
- No publication-race changes: explicit constraints Tasks 4/7.
- Final exact-master evidence: Task 7.

No task depends on old-attempt artifact visibility or undocumented cross-attempt job outputs.