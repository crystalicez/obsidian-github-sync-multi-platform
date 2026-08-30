# Live GitHub E2E Safety — Ready Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute exact CI-produced real-GitHub E2E bundles on a fresh credentialed runner against one pinned disposable repository, with safe cleanup and release qualification bound to one cohesive current workflow attempt.

**Architecture:** Ordinary read-only `ci.yml` is the sole compiler of the three release-qualifying live-E2E bundles. `github-e2e-live.yml` becomes a no-checkout/no-install/no-build consumer: it selects the newest exact-SHA CI run/current attempt, downloads and validates the immutable artifact archive before extraction, proves a pinned numeric target identity, persists a same-attempt provenance receipt before target mutation, executes only the three fixed verified bundles, and independently re-proves the pinned target before cleanup. Release qualification never mixes live workflow attempts: the current attempt must contain successful `qualify`, a valid same-attempt receipt, and successful `cleanup`.

**Tech Stack:** Node.js `v22.11.0`, TypeScript, ESM, esbuild, Node `node:test`, pnpm `9.12.3`, GitHub Actions, GitHub REST API `2026-03-10`, Python standard-library `zipfile`, full-SHA-pinned external Actions.

**Spec:** `docs/superpowers/specs/2026-08-30-live-github-e2e-safety-design.md`

## Global Constraints

- Approved design baseline is `35e98cea924702293bde62d064a83d52eca6d898`. If `master` materially changes before execution, rebase and re-review the affected assumptions before coding.
- CI is the sole compiler of release-qualifying E2E bundles.
- Live `qualify` must not checkout repository code, invoke pnpm/npm, install project dependencies, build, or compile.
- Source `GITHUB_TOKEN` remains read-only: `actions: read`, `contents: read`.
- `E2E_TOKEN` is step-scoped and its mutable repository scope is limited to the dedicated disposable target repository.
- `E2E_REPO_ID` is mandatory pinned target identity. `E2E_OWNER/E2E_REPO` are routing only.
- Release-qualifying branch is exactly `obsidian-sync-e2e/run-${GITHUB_RUN_ID}`.
- Target repository has an initialized readable default branch, and the disposable branch must differ from it.
- Default-branch Git-ref readability is proven before exact disposable-ref absence is interpreted.
- Qualification receipt upload succeeds before any live scenario target mutation.
- Current/latest live workflow attempt must contain `qualify=success`, same-attempt receipt, and `cleanup=success` to qualify a release.
- `Re-run failed jobs` may repair cleanup residue but is maintenance-only. Use `Re-run all jobs` to restore cohesive release qualification.
- Every external `uses:` reference in repository workflows is pinned to a verified full-length commit SHA.
- Do not implement Child C publication-race typing/retry changes in this plan.
- Do not redesign Stable Release beyond mechanical Action pinning; Child A owns publication changes.
- No new npm dependency.

## File Map

### Create

- `scripts/github-e2e-input.mjs` — deterministic source-side bundle producer and provenance-manifest writer.
- `tests/github-e2e/support/target-safety.ts` — shared target identity, ref-capability, and reset authority bundled into all live suites.
- `tests/feasibility/github-actions-pinning.test.mjs`
- `tests/feasibility/github-e2e-input.test.mjs`
- `tests/feasibility/github-e2e-target-safety.test.ts`
- `tests/feasibility/github-e2e-suite-safety-contract.test.mjs`
- `tests/feasibility/github-e2e-live-workflow-contract.test.mjs`

### Modify

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

## Task 1: Pin Every External GitHub Action

**Files:**
- Create: `tests/feasibility/github-actions-pinning.test.mjs`
- Modify: all `.github/workflows/*.yml`

**Interfaces:**
- Produces invariant: every external `uses:` value is `owner/repo[@subpath]@<40 lowercase hex commit SHA>`; local `./...` Actions remain allowed.

- [ ] **Step 1: Write the failing static contract**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workflowDir = resolve(".github/workflows");

test("external workflow actions are full-SHA pinned", async () => {
  const failures = [];
  const files = (await readdir(workflowDir)).filter(name => /\.ya?ml$/u.test(name)).sort();
  for (const file of files) {
    const text = await readFile(resolve(workflowDir, file), "utf8");
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      const match = line.match(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/u);
      if (!match || match[1].startsWith("./")) continue;
      if (!/^[^@\s]+@[0-9a-f]{40}$/u.test(match[1])) failures.push(`${file}:${index + 1}: ${match[1]}`);
    }
  }
  assert.deepEqual(failures, []);
});
```

- [ ] **Step 2: Run red test**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-actions-pinning
```

Expected: FAIL on current mutable `@v4`/`@v6` refs.

- [ ] **Step 3: Pin the currently verified commits**

```yaml
uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
```

Only replace refs in `pre-release.yml` and `release.yml`; do not redesign those workflows in Child B.

- [ ] **Step 4: Verify green**

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

## Task 2: Make CI Produce the Exact Live-E2E Artifact

**Files:**
- Create: `scripts/github-e2e-input.mjs`
- Create: `tests/feasibility/github-e2e-input.test.mjs`
- Modify: `scripts/run-github-e2e.mjs`
- Modify: `tests/feasibility/github-e2e-compile-cli.test.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

```js
export const GITHUB_E2E_ENTRY_POINTS
export const GITHUB_E2E_BUNDLES
export async function compileGitHubE2EBundles({ root, outDir })
export async function writeGitHubE2EInputManifest({ outDir, env, nodeVersion })
```

CLI additions:

```text
--out-dir=<path>
--write-input-manifest
```

CI artifact name:

```text
github-e2e-input-${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

Exact logical files:

```text
github-e2e-input.json
v4-real-github-e2e.test.mjs
v4-copy-contract-github-e2e.test.mjs
v4-encrypted-external-mutation.test.mjs
```

- [ ] **Step 1: Extend compile-only tests first**

Add this case to `tests/feasibility/github-e2e-compile-cli.test.mjs`:

```js
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

test("compile-only ignores target env files and emits only fixed bundles", async () => {
  const outDir = await mkdtemp(resolve(tmpdir(), "github-e2e-compile-"));
  await writeFile(resolve(outDir, "stale.txt"), "stale\n");
  const env = { ...process.env, GITHUB_E2E_ENV_FILE: resolve(outDir, "missing.env") };
  for (const key of ["GITHUB_E2E_OWNER", "GITHUB_E2E_REPO", "GITHUB_E2E_BRANCH", "GITHUB_E2E_TOKEN", "GITHUB_E2E_EXPECTED_REPO_ID"]) delete env[key];
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

- [ ] **Step 2: Write producer manifest tests first**

Create `tests/feasibility/github-e2e-input.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { GITHUB_E2E_BUNDLES, writeGitHubE2EInputManifest } from "../../scripts/github-e2e-input.mjs";

const goodEnv = {
  GITHUB_REPOSITORY_ID: "1282135059",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "1234",
  GITHUB_RUN_ATTEMPT: "2",
};

async function makeBundles() {
  const outDir = await mkdtemp(resolve(tmpdir(), "github-e2e-input-test-"));
  for (const name of GITHUB_E2E_BUNDLES) await writeFile(resolve(outDir, name), `bundle:${name}\n`);
  return outDir;
}

test("manifest binds exact bundles to CI attempt", async () => {
  const outDir = await makeBundles();
  await writeGitHubE2EInputManifest({ outDir, env: goodEnv, nodeVersion: "v22.11.0" });
  assert.deepEqual((await readdir(outDir)).sort(), ["github-e2e-input.json", ...GITHUB_E2E_BUNDLES].sort());
  const manifest = JSON.parse(await readFile(resolve(outDir, "github-e2e-input.json"), "utf8"));
  assert.deepEqual(manifest.bundles.map(item => item.name), GITHUB_E2E_BUNDLES);
  assert.equal(manifest.repositoryId, goodEnv.GITHUB_REPOSITORY_ID);
  assert.equal(manifest.commitSha, goodEnv.GITHUB_SHA);
  assert.equal(manifest.workflowRunId, goodEnv.GITHUB_RUN_ID);
  assert.equal(manifest.workflowRunAttempt, 2);
  assert.equal(manifest.nodeVersion, "v22.11.0");
  assert.ok(manifest.bundles.every(item => Number.isSafeInteger(item.size) && item.size > 0 && /^[0-9a-f]{64}$/u.test(item.sha256)));
});

test("manifest rejects invalid producer fields", async () => {
  for (const [key, value] of [
    ["GITHUB_REPOSITORY_ID", "0"],
    ["GITHUB_SHA", "bad"],
    ["GITHUB_RUN_ID", "0"],
    ["GITHUB_RUN_ATTEMPT", "0"],
  ]) {
    const outDir = await makeBundles();
    await assert.rejects(writeGitHubE2EInputManifest({ outDir, env: { ...goodEnv, [key]: value }, nodeVersion: "v22.11.0" }), new RegExp(key, "u"));
  }
});

test("manifest rejects empty or extra entries", async () => {
  const emptyDir = await makeBundles();
  await writeFile(resolve(emptyDir, GITHUB_E2E_BUNDLES[0]), "");
  await assert.rejects(writeGitHubE2EInputManifest({ outDir: emptyDir, env: goodEnv, nodeVersion: "v22.11.0" }), /empty/u);

  const extraDir = await makeBundles();
  await writeFile(resolve(extraDir, "unexpected.txt"), "x");
  await assert.rejects(writeGitHubE2EInputManifest({ outDir: extraDir, env: goodEnv, nodeVersion: "v22.11.0" }), /unexpected entries/u);
});
```

- [ ] **Step 3: Run red tests**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-compile-cli
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-input
```

Expected: FAIL because producer module/CLI behavior does not exist.

- [ ] **Step 4: Implement producer module**

Create `scripts/github-e2e-input.mjs`:

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
  const actual = (await readdir(outDir)).sort();
  const expected = [...GITHUB_E2E_BUNDLES].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) throw new Error("GitHub E2E input directory contains unexpected entries before manifest creation.");
  const bundles = [];
  for (const name of GITHUB_E2E_BUNDLES) {
    const file = resolve(outDir, name);
    const info = await stat(file);
    if (!info.isFile()) throw new Error(`GitHub E2E bundle is not a regular file: ${name}`);
    const bytes = await readFile(file);
    if (bytes.byteLength === 0) throw new Error(`GitHub E2E bundle is empty: ${name}`);
    bundles.push({ name, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
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

In `scripts/run-github-e2e.mjs`, import producer functions and determine compile mode **before** env-file loading:

```js
import { compileGitHubE2EBundles, writeGitHubE2EInputManifest } from "./github-e2e-input.mjs";

const compileOnly = process.argv.includes("--compile-only") || process.env.GITHUB_E2E_COMPILE_ONLY === "1";
if (!compileOnly) loadEnvFile();
function optionValue(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(value => value.startsWith(prefix))?.slice(prefix.length);
}
const requestedOutDir = optionValue("out-dir");
const writeInputManifest = process.argv.includes("--write-input-manifest");
const outDir = requestedOutDir
  ? (path.isAbsolute(requestedOutDir) ? requestedOutDir : path.join(root, requestedOutDir))
  : path.join(root, ".tmp", "github-e2e", `${process.pid}-${Date.now()}`);
const outfiles = await compileGitHubE2EBundles({ root, outDir });
if (writeInputManifest) await writeGitHubE2EInputManifest({ outDir });
if (compileOnly) {
  for (const outfile of outfiles) console.log(`GitHub E2E bundle compiled: ${outfile}`);
  process.exit(0);
}
```

Keep serial local execution after this block:

```js
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...outfiles], { cwd: root, stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
```

- [ ] **Step 6: Update CI producer**

Replace the compile gate with:

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

Keep `plugin-${{ github.sha }}` unchanged in Child B.

- [ ] **Step 7: Verify and commit**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-compile-cli
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-input
corepack pnpm test:github-e2e:compile
```

Expected: PASS without target credentials.

```bash
git add scripts/github-e2e-input.mjs scripts/run-github-e2e.mjs tests/feasibility/github-e2e-compile-cli.test.mjs tests/feasibility/github-e2e-input.test.mjs .github/workflows/ci.yml
git commit -m "test: produce provenance-bound github e2e bundles"
```

---

## Task 3: Centralize Target Identity and Reset Safety

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

- [ ] **Step 1: Write mocked safety tests before implementation**

Use this deterministic fetch harness:

```ts
function scriptedFetch(steps: Array<{ method?: string; path: string; status: number; body?: unknown }>): GitHubE2EFetch {
  let index = 0
  return async (url, init = {}) => {
    const step = steps[index++]
    assert.ok(step, `unexpected request ${(init.method ?? "GET").toUpperCase()} ${url}`)
    assert.equal((init.method ?? "GET").toUpperCase(), step.method ?? "GET")
    assert.equal(new URL(url).pathname, step.path)
    return new Response(step.body === undefined ? "" : JSON.stringify(step.body), { status: step.status, headers: { "content-type": "application/json" } })
  }
}
```

Define:

```ts
const base = {
  owner: "TargetOwner",
  repo: "TargetRepo",
  branch: "obsidian-sync-e2e/run-77",
  token: "test-token",
  expectedRepositoryId: "222",
  sourceRepositoryId: "111",
  requiredBranch: "obsidian-sync-e2e/run-77",
} satisfies GitHubE2ETargetEnvironment
const metadata = { id: 222, full_name: "CanonicalOwner/CanonicalRepo", default_branch: "trunk" }
const defaultRef = { object: { sha: "d".repeat(40) } }
```

Implement these test cases explicitly:

```ts
test("rejects pinned ID mismatch", async () => {
  await assert.rejects(resolveGitHubE2ETarget(base, scriptedFetch([
    { path: "/repos/TargetOwner/TargetRepo", status: 200, body: { ...metadata, id: 333 } },
  ])), /pinned repository ID/u)
})

test("rejects source repository ID", async () => {
  await assert.rejects(resolveGitHubE2ETarget({ ...base, expectedRepositoryId: "111" }, scriptedFetch([
    { path: "/repos/TargetOwner/TargetRepo", status: 200, body: { ...metadata, id: 111 } },
  ])), /must not be the source repository/u)
})

test("requires default-ref capability before absence", async () => {
  await assert.rejects(resetGitHubE2EDisposableBranch(base, scriptedFetch([
    { path: "/repos/TargetOwner/TargetRepo", status: 200, body: metadata },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/ref/heads/trunk", status: 404, body: { message: "Not Found" } },
  ])), /Git-ref read capability/u)
})

test("accepts exact missing ref only after capability", async () => {
  const result = await resetGitHubE2EDisposableBranch(base, scriptedFetch([
    { path: "/repos/TargetOwner/TargetRepo", status: 200, body: metadata },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/ref/heads/trunk", status: 200, body: defaultRef },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/refs/heads/obsidian-sync-e2e/run-77", status: 404, body: { message: "Not Found" } },
  ]))
  assert.equal(result.repositoryId, "222")
})

test("rejects arbitrary 422", async () => {
  await assert.rejects(resetGitHubE2EDisposableBranch(base, scriptedFetch([
    { path: "/repos/TargetOwner/TargetRepo", status: 200, body: metadata },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/ref/heads/trunk", status: 200, body: defaultRef },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/refs/heads/obsidian-sync-e2e/run-77", status: 422, body: { message: "Validation Failed" } },
  ])), /Cannot inspect GitHub E2E disposable ref/u)
})

test("concurrent already-absent delete is verified", async () => {
  await resetGitHubE2EDisposableBranch(base, scriptedFetch([
    { path: "/repos/TargetOwner/TargetRepo", status: 200, body: metadata },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/ref/heads/trunk", status: 200, body: defaultRef },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/refs/heads/obsidian-sync-e2e/run-77", status: 200, body: { object: { sha: "a".repeat(40) } } },
    { method: "DELETE", path: "/repos/CanonicalOwner/CanonicalRepo/git/refs/heads/obsidian-sync-e2e/run-77", status: 422, body: { message: "Reference does not exist" } },
    { path: "/repos/TargetOwner/TargetRepo", status: 200, body: metadata },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/ref/heads/trunk", status: 200, body: defaultRef },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/refs/heads/obsidian-sync-e2e/run-77", status: 404, body: { message: "Not Found" } },
  ]))
})
```

Also add direct assertions for actual-default-branch rejection, Actions required-branch mismatch, post-delete default-ref capability loss, missing `GITHUB_E2E_EXPECTED_REPO_ID`, and nonnumeric expected ID.

- [ ] **Step 2: Run red test**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-target-safety
```

Expected: FAIL because helper does not exist.

- [ ] **Step 3: Implement shared helper**

Create `tests/github-e2e/support/target-safety.ts` with:

```ts
import type { GitHubConfig } from "../../../src/lib/github-api"

const API = "https://api.github.com"
const FORBIDDEN_LOCAL_BRANCHES = new Set(["main", "master", "production", "prod", "release", "stable"])

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

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}
function headers(token: string) {
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2026-03-10" }
}
async function json<T>(response: Response, statuses: readonly number[], action: string): Promise<T> {
  const text = await response.text()
  if (!statuses.includes(response.status)) throw new Error(`${action}: HTTP ${response.status} ${text}`)
  return (text ? JSON.parse(text) : {}) as T
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

export async function resolveGitHubE2ETarget(input: GitHubE2ETargetEnvironment, request: GitHubE2EFetch = fetch): Promise<ResolvedGitHubE2ETarget> {
  const route = `${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`
  const metadata = await json<{ id?: number; full_name?: string; default_branch?: string }>(
    await request(`${API}/repos/${route}`, { headers: headers(input.token) }), [200], "Cannot inspect GitHub E2E repository",
  )
  const repositoryId = String(metadata.id ?? "")
  if (repositoryId !== input.expectedRepositoryId) throw new Error("GitHub E2E target repository ID does not match the pinned repository ID.")
  if (input.sourceRepositoryId && repositoryId === input.sourceRepositoryId) throw new Error("GitHub E2E target repository must not be the source repository.")
  if (!metadata.full_name || !metadata.default_branch) throw new Error("GitHub E2E repository metadata is incomplete.")
  if (input.requiredBranch && input.branch !== input.requiredBranch) throw new Error("GitHub E2E branch does not match the required workflow branch.")
  if (input.branch === metadata.default_branch) throw new Error("GITHUB_E2E_BRANCH must not be the repository default branch.")
  const [owner, repo, ...extra] = metadata.full_name.split("/")
  if (!owner || !repo || extra.length) throw new Error("GitHub E2E repository full_name is invalid.")
  const base = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const defaultRef = await json<{ object?: { sha?: string } }>(
    await request(`${base}/git/ref/heads/${encodeGitHubE2ERefPath(metadata.default_branch)}`, { headers: headers(input.token) }),
    [200], "Cannot prove Git-ref read capability on target default branch",
  )
  if (!defaultRef.object?.sha) throw new Error("Target default-branch ref is missing its commit SHA.")
  return { config: { owner, repo, branch: input.branch, token: input.token }, repositoryId, fullName: metadata.full_name, defaultBranch: metadata.default_branch, defaultBranchSha: defaultRef.object.sha }
}

async function recognizedMissingRef(response: Response): Promise<boolean> {
  if (response.status === 404) { await response.arrayBuffer().catch(() => undefined); return true }
  if (response.status !== 422) return false
  const text = await response.text()
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
  if (deleted.status === 204) await deleted.arrayBuffer().catch(() => undefined)
  else if (!(await recognizedMissingRef(deleted))) throw new Error(`Cannot remove GitHub E2E disposable ref: HTTP ${deleted.status}`)
  for (let attempt = 1; attempt <= 3; attempt++) {
    await resolveGitHubE2ETarget(input, request)
    const verify = await request(exact, { headers: auth })
    if (await recognizedMissingRef(verify)) return target
    if (verify.status !== 200) throw new Error(`Cannot verify GitHub E2E disposable ref absence: HTTP ${verify.status}`)
    await verify.arrayBuffer().catch(() => undefined)
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 500))
  }
  throw new Error(`GitHub E2E disposable branch still exists: ${input.branch}`)
}
```

The `status !== 422` check occurs before `response.text()` so a normal 200 response body is not consumed twice.

- [ ] **Step 4: Verify and commit**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-target-safety
```

Expected: PASS without network.

```bash
git add tests/github-e2e/support/target-safety.ts tests/feasibility/github-e2e-target-safety.test.ts
git commit -m "test: centralize github e2e target safety"
```

---

## Task 4: Migrate All Three Suites and Local Runner

**Files:**
- Create: `tests/feasibility/github-e2e-suite-safety-contract.test.mjs`
- Modify: all three `tests/github-e2e/*.test.ts`
- Modify: `scripts/run-github-e2e.mjs`
- Modify: `tests/feasibility/github-e2e-compile-cli.test.mjs`

**Interfaces:**
- Credentialed execution requires `GITHUB_E2E_EXPECTED_REPO_ID`.
- Actions additionally provides `GITHUB_E2E_SOURCE_REPO_ID` and `GITHUB_E2E_REQUIRED_BRANCH`.
- Existing scenario logic and Child-C-owned stale-ref retry policy stay unchanged.

- [ ] **Step 1: Write migration contract first**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const suites = [
  "tests/github-e2e/v4-real-github-e2e.test.ts",
  "tests/github-e2e/v4-copy-contract-github-e2e.test.ts",
  "tests/github-e2e/v4-encrypted-external-mutation.test.ts",
];

test("credentialed suites delegate target safety", async () => {
  for (const file of suites) {
    const text = await readFile(resolve(file), "utf8");
    assert.match(text, /\.\/support\/target-safety/u, file);
    assert.match(text, /resetGitHubE2EDisposableBranch/u, file);
    assert.doesNotMatch(text, /async function deleteTestBranch/u, file);
    assert.doesNotMatch(text, /const forbiddenBranches/u, file);
  }
});
```

Add to compile CLI tests:

```js
test("credentialed runner requires expected target repository ID before execution", () => {
  const env = { ...process.env };
  delete env.GITHUB_E2E_ENV_FILE;
  env.GITHUB_E2E_OWNER = "owner";
  env.GITHUB_E2E_REPO = "repo";
  env.GITHUB_E2E_BRANCH = "local-e2e";
  env.GITHUB_E2E_TOKEN = "test-token";
  delete env.GITHUB_E2E_EXPECTED_REPO_ID;
  const result = spawnSync(process.execPath, [resolve("scripts/run-github-e2e.mjs")], { cwd: resolve("."), env, encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /GITHUB_E2E_EXPECTED_REPO_ID/u);
});
```

- [ ] **Step 2: Run red tests**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-suite-safety-contract
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-compile-cli
```

Expected: FAIL.

- [ ] **Step 3: Require expected ID only in credentialed mode**

Set non-compile required environment list to:

```js
const required = [
  "GITHUB_E2E_OWNER",
  "GITHUB_E2E_REPO",
  "GITHUB_E2E_BRANCH",
  "GITHUB_E2E_TOKEN",
  "GITHUB_E2E_EXPECTED_REPO_ID",
];
```

Missing configuration exits with code `2` before compilation/network. Compile-only remains credential-free.

- [ ] **Step 4: Migrate each suite**

Add:

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

Replace scenario-start and `after()` branch cleanup with:

```ts
await resetGitHubE2EDisposableBranch(targetEnvironment)
```

Use `encodeGitHubE2ERefPath(github.branch)` in scenario-specific external interference code. Remove duplicated env/forbidden/delete helpers. Keep existing main/copy wrapper regex retry logic untouched for Child C.

- [ ] **Step 5: Verify and commit**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-suite-safety-contract
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-compile-cli
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-target-safety
corepack pnpm test:github-e2e:compile
```

Expected: PASS.

```bash
git add scripts/run-github-e2e.mjs tests/github-e2e tests/feasibility/github-e2e-suite-safety-contract.test.mjs tests/feasibility/github-e2e-compile-cli.test.mjs
git commit -m "test: enforce pinned live e2e repository identity"
```

---

## Task 5: Rewrite GitHub E2E Live as a Verified Artifact Executor

**Files:**
- Create: `tests/feasibility/github-e2e-live-workflow-contract.test.mjs`
- Modify: `.github/workflows/github-e2e-live.yml`

**Interfaces:**

```text
vars.E2E_OWNER
vars.E2E_REPO
vars.E2E_REPO_ID
secrets.E2E_TOKEN
receipt = github-e2e-target-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

- [ ] **Step 1: Write static workflow contract first**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workflow = resolve(".github/workflows/github-e2e-live.yml");

test("live workflow runs verified CI bundles without source build", async () => {
  const text = await readFile(workflow, "utf8");
  assert.match(text, /actions:\s*read/u);
  assert.match(text, /contents:\s*read/u);
  assert.doesNotMatch(text, /actions\/checkout@/u);
  assert.doesNotMatch(text, /pnpm\/action-setup@/u);
  assert.doesNotMatch(text, /pnpm install|pnpm build|run-github-e2e\.mjs/u);
  assert.match(text, /github-e2e-input-/u);
  assert.match(text, /E2E_REPO_ID/u);
  assert.match(text, /node --test --test-concurrency=1/u);
  assert.doesNotMatch(text, /^ {4}env:/mu);
});

test("receipt upload is blocking and precedes scenario execution", async () => {
  const text = await readFile(workflow, "utf8");
  const receipt = text.indexOf("Upload same-attempt qualification receipt");
  const execute = text.indexOf("Run verified real GitHub E2E bundles");
  assert.ok(receipt >= 0 && execute > receipt);
  assert.match(text, /github-e2e-target-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  assert.doesNotMatch(text.slice(receipt, execute), /continue-on-error:\s*true/u);
});

test("cleanup is independent and cohesive-attempt rule is explicit", async () => {
  const text = await readFile(workflow, "utf8");
  assert.match(text, /if:\s*always\(\)/u);
  assert.ok((text.match(/environment:\s*github-e2e/gu) ?? []).length >= 2);
  assert.doesNotMatch(text, /needs\.qualify\.outputs/u);
  assert.match(text, /cleanup-only rerun may remove residue but is not release qualification/u);
});
```

- [ ] **Step 2: Run red test**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-live-workflow-contract
```

Expected: FAIL because current workflow checks out/builds and exposes target config job-wide.

- [ ] **Step 3: Replace workflow header and job skeleton exactly**

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

jobs:
  qualify:
    name: qualify
    runs-on: ubuntu-latest
    timeout-minutes: 25
    environment: github-e2e
    steps:
      - name: Select authoritative CI E2E input
        id: ci
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          node <<'NODE'
          // Insert the selector implementation from Step 4 verbatim.
          NODE
      - name: Download and verify CI E2E archive
        env:
          GH_TOKEN: ${{ github.token }}
          ARTIFACT_ID: ${{ steps.ci.outputs.artifact_id }}
          ARTIFACT_DIGEST: ${{ steps.ci.outputs.artifact_digest }}
          CI_RUN_ID: ${{ steps.ci.outputs.run_id }}
          CI_RUN_ATTEMPT: ${{ steps.ci.outputs.run_attempt }}
          NODE_VERSION: ${{ steps.ci.outputs.node_version }}
          SOURCE_REPOSITORY_ID: ${{ github.repository_id }}
          SOURCE_SHA: ${{ github.sha }}
        run: |
          set -euo pipefail
          # Insert archive download/hash/validation implementation from Step 5 verbatim.
      - name: Setup exact Node.js runtime
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
        with:
          node-version: ${{ steps.ci.outputs.node_version }}
      - name: Guard pinned qualification target
        id: target
        env:
          E2E_OWNER: ${{ vars.E2E_OWNER }}
          E2E_REPO: ${{ vars.E2E_REPO }}
          E2E_REPO_ID: ${{ vars.E2E_REPO_ID }}
          E2E_TOKEN: ${{ secrets.E2E_TOKEN }}
          E2E_BRANCH: obsidian-sync-e2e/run-${{ github.run_id }}
          SOURCE_REPOSITORY_ID: ${{ github.repository_id }}
        run: |
          node <<'NODE'
          // Insert target guard implementation from Step 6 verbatim.
          NODE
      - name: Write same-attempt qualification receipt
        env:
          CI_RUN_ID: ${{ steps.ci.outputs.run_id }}
          CI_RUN_ATTEMPT: ${{ steps.ci.outputs.run_attempt }}
          CI_ARTIFACT_ID: ${{ steps.ci.outputs.artifact_id }}
          CI_ARTIFACT_DIGEST: ${{ steps.ci.outputs.artifact_digest }}
          TARGET_REPOSITORY_ID: ${{ steps.target.outputs.repository_id }}
          TARGET_FULL_NAME: ${{ steps.target.outputs.full_name }}
          TARGET_DEFAULT_BRANCH: ${{ steps.target.outputs.default_branch }}
          TARGET_BRANCH: ${{ steps.target.outputs.branch }}
        run: |
          node <<'NODE'
          // Insert receipt writer from Step 7 verbatim.
          NODE
      - name: Upload same-attempt qualification receipt
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: github-e2e-target-${{ github.run_id }}-${{ github.run_attempt }}
          path: .tmp/github-e2e-receipt/github-e2e-target.json
          if-no-files-found: error
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

  cleanup:
    name: cleanup
    if: always()
    needs: qualify
    runs-on: ubuntu-latest
    timeout-minutes: 5
    environment: github-e2e
    steps:
      - name: Delete and verify pinned disposable branch
        env:
          E2E_OWNER: ${{ vars.E2E_OWNER }}
          E2E_REPO: ${{ vars.E2E_REPO }}
          E2E_REPO_ID: ${{ vars.E2E_REPO_ID }}
          E2E_TOKEN: ${{ secrets.E2E_TOKEN }}
          E2E_BRANCH: obsidian-sync-e2e/run-${{ github.run_id }}
          SOURCE_REPOSITORY_ID: ${{ github.repository_id }}
        run: |
          # A cleanup-only rerun may remove residue but is not release qualification;
          # release qualification requires qualify + receipt + cleanup in one current attempt.
          node <<'NODE'
          // Insert cleanup implementation from Step 8 verbatim.
          NODE
```

The four `Insert ... verbatim` comments above are **assembly markers only inside this plan excerpt**. The actual content to paste is fully specified immediately in Steps 4–8; do not leave any marker in the committed workflow. The static contract additionally rejects the literal string `Insert ` to enforce this.

Add to the first static test:

```js
assert.doesNotMatch(text, /Insert .* verbatim/u);
```

- [ ] **Step 4: Implement authoritative CI selector verbatim**

```js
const { appendFileSync } = require("node:fs");
const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" };
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
  const byTime = Date.parse(right.created_at) - Date.parse(left.created_at);
  if (byTime) return byTime;
  const a = BigInt(String(left.id));
  const b = BigInt(String(right.id));
  return a === b ? 0 : b > a ? 1 : -1;
}
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
const verify = jobs.filter(job => job.name === "verify");
if (verify.length !== 1 || verify[0].status !== "completed" || verify[0].conclusion !== "success") throw new Error("CI verify job is not uniquely successful in the current attempt.");
const artifactName = `github-e2e-input-${process.env.GITHUB_SHA}-${run.id}-${attempt}`;
const artifacts = await listAll(`/actions/runs/${run.id}/artifacts`, "artifacts");
const matches = artifacts.filter(item => item.name === artifactName && item.expired === false);
if (matches.length !== 1) throw new Error(`Expected exactly one current CI E2E artifact: ${artifactName}`);
const artifact = matches[0];
if (String(artifact.workflow_run?.id ?? "") !== String(run.id) || String(artifact.workflow_run?.repository_id ?? "") !== process.env.GITHUB_REPOSITORY_ID || artifact.workflow_run?.head_sha !== process.env.GITHUB_SHA) throw new Error("CI E2E artifact metadata does not bind to the selected producer.");
const source = await api(`/contents/.node-version?ref=${process.env.GITHUB_SHA}`);
const nodeVersion = Buffer.from(source.content ?? "", "base64").toString("utf8").trim();
if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(nodeVersion)) throw new Error("Exact source .node-version is invalid.");
for (const [name, value] of Object.entries({ run_id: String(run.id), run_attempt: String(attempt), artifact_id: String(artifact.id), artifact_digest: artifact.digest ?? "", node_version: nodeVersion })) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
```

- [ ] **Step 5: Implement archive download, digest check, and safe extraction verbatim**

Use this shell before Python validation:

```bash
set -euo pipefail
rm -rf .tmp/github-e2e-download .tmp/github-e2e-verified
mkdir -p .tmp/github-e2e-download .tmp/github-e2e-verified
curl --fail-with-body --silent --show-error --location \
  --header "Accept: application/vnd.github+json" \
  --header "Authorization: Bearer $GH_TOKEN" \
  --header "X-GitHub-Api-Version: 2026-03-10" \
  "https://api.github.com/repos/$GITHUB_REPOSITORY/actions/artifacts/$ARTIFACT_ID/zip" \
  --output .tmp/github-e2e-download/input.zip
if [[ -n "$ARTIFACT_DIGEST" ]]; then
  [[ "$ARTIFACT_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "invalid artifact digest shape" >&2; exit 1; }
  expected="${ARTIFACT_DIGEST#sha256:}"
  actual="$(sha256sum .tmp/github-e2e-download/input.zip | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || { echo "artifact archive digest mismatch" >&2; exit 1; }
fi
```

Then run:

```py
import hashlib, json, os
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

archive = Path(".tmp/github-e2e-download/input.zip")
out = Path(".tmp/github-e2e-verified")
bundle_names = [
    "v4-real-github-e2e.test.mjs",
    "v4-copy-contract-github-e2e.test.mjs",
    "v4-encrypted-external-mutation.test.mjs",
]
expected = {"github-e2e-input.json", *bundle_names}

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result

with ZipFile(archive) as zf:
    infos = zf.infolist()
    names = [info.filename for info in infos]
    if len(names) != len(set(names)) or set(names) != expected:
        raise SystemExit("unexpected GitHub E2E artifact entries")
    for info in infos:
        path = PurePosixPath(info.filename)
        mode = (info.external_attr >> 16) & 0o170000
        if path.is_absolute() or ".." in path.parts or "\\" in info.filename or info.is_dir() or mode == 0o120000:
            raise SystemExit(f"unsafe GitHub E2E artifact entry: {info.filename}")
    manifest = json.loads(zf.read("github-e2e-input.json"), object_pairs_hook=unique_object)
    identity = {
        "schemaVersion": 1,
        "repositoryId": os.environ["SOURCE_REPOSITORY_ID"],
        "commitSha": os.environ["SOURCE_SHA"],
        "workflowRunId": os.environ["CI_RUN_ID"],
        "workflowRunAttempt": int(os.environ["CI_RUN_ATTEMPT"]),
        "nodeVersion": os.environ["NODE_VERSION"],
    }
    for key, value in identity.items():
        if manifest.get(key) != value:
            raise SystemExit(f"GitHub E2E manifest mismatch: {key}")
    bundles = manifest.get("bundles")
    if not isinstance(bundles, list) or [item.get("name") for item in bundles if isinstance(item, dict)] != bundle_names or len(bundles) != len(bundle_names):
        raise SystemExit("GitHub E2E manifest bundle allowlist mismatch")
    out.mkdir(parents=True, exist_ok=True)
    for item in bundles:
        if not isinstance(item, dict) or set(item) != {"name", "size", "sha256"}:
            raise SystemExit("invalid GitHub E2E bundle manifest fields")
        name = item["name"]
        data = zf.read(name)
        if type(item["size"]) is not int or item["size"] <= 0 or item["size"] != len(data):
            raise SystemExit(f"bundle size mismatch: {name}")
        digest = hashlib.sha256(data).hexdigest()
        if item["sha256"] != digest:
            raise SystemExit(f"bundle digest mismatch: {name}")
        (out / name).write_bytes(data)
```

Do not use `extractall()`.

- [ ] **Step 6: Implement target guard verbatim**

```js
const { appendFileSync } = require("node:fs");
const owner = process.env.E2E_OWNER?.trim();
const repo = process.env.E2E_REPO?.trim();
const expectedId = process.env.E2E_REPO_ID?.trim();
const token = process.env.E2E_TOKEN;
const branch = process.env.E2E_BRANCH;
if (!owner || !repo || !token || !branch || !/^[1-9][0-9]*$/u.test(expectedId ?? "")) throw new Error("Incomplete GitHub E2E target configuration.");
const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" };
async function getJson(url, action) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`${action}: HTTP ${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}
const metadata = await getJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, "Cannot resolve target repository");
const actualId = String(metadata.id ?? "");
if (actualId !== expectedId) throw new Error("Target repository ID differs from pinned E2E_REPO_ID.");
if (actualId === process.env.SOURCE_REPOSITORY_ID) throw new Error("Target repository equals source repository.");
if (!metadata.full_name || !metadata.default_branch) throw new Error("Target repository metadata is incomplete.");
if (branch === metadata.default_branch) throw new Error("Disposable branch equals target default branch.");
const [canonicalOwner, canonicalRepo, ...extra] = metadata.full_name.split("/");
if (!canonicalOwner || !canonicalRepo || extra.length) throw new Error("Invalid target canonical full_name.");
const encodeRef = value => value.split("/").map(encodeURIComponent).join("/");
const base = `https://api.github.com/repos/${encodeURIComponent(canonicalOwner)}/${encodeURIComponent(canonicalRepo)}`;
const defaultRef = await getJson(`${base}/git/ref/heads/${encodeRef(metadata.default_branch)}`, "Cannot prove target default-ref capability");
if (!defaultRef.object?.sha) throw new Error("Target default ref lacks commit SHA.");
for (const [name, value] of Object.entries({ owner: canonicalOwner, repo: canonicalRepo, repository_id: actualId, full_name: metadata.full_name, default_branch: metadata.default_branch, branch })) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
```

- [ ] **Step 7: Implement same-attempt receipt writer verbatim**

```js
const fs = require("node:fs");
const path = require("node:path");
function integer(name) {
  const value = process.env[name] ?? "";
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`Invalid receipt integer: ${name}`);
  return Number(value);
}
const digest = process.env.CI_ARTIFACT_DIGEST || null;
if (digest !== null && !/^sha256:[0-9a-f]{64}$/u.test(digest)) throw new Error("Invalid CI artifact digest in receipt.");
const receipt = {
  schemaVersion: 1,
  sourceRepositoryId: process.env.GITHUB_REPOSITORY_ID,
  sourceCommitSha: process.env.GITHUB_SHA,
  workflowRunId: process.env.GITHUB_RUN_ID,
  workflowRunAttempt: integer("GITHUB_RUN_ATTEMPT"),
  ciProducerRunId: process.env.CI_RUN_ID,
  ciProducerRunAttempt: integer("CI_RUN_ATTEMPT"),
  ciE2EArtifactId: process.env.CI_ARTIFACT_ID,
  ciE2EArtifactDigest: digest,
  targetRepositoryId: process.env.TARGET_REPOSITORY_ID,
  targetFullName: process.env.TARGET_FULL_NAME,
  targetDefaultBranch: process.env.TARGET_DEFAULT_BRANCH,
  targetBranch: process.env.TARGET_BRANCH,
};
for (const key of ["sourceRepositoryId", "sourceCommitSha", "workflowRunId", "ciProducerRunId", "ciE2EArtifactId", "targetRepositoryId", "targetFullName", "targetDefaultBranch", "targetBranch"]) {
  if (!receipt[key]) throw new Error(`Missing receipt field: ${key}`);
}
const dir = ".tmp/github-e2e-receipt";
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "github-e2e-target.json"), `${JSON.stringify(receipt, null, 2)}\n`);
```

The step env must include `GITHUB_REPOSITORY_ID`, `GITHUB_SHA`, `GITHUB_RUN_ID`, and `GITHUB_RUN_ATTEMPT` from default Actions context plus the CI/target values shown in Step 3.

- [ ] **Step 8: Implement cleanup verbatim**

```js
const owner = process.env.E2E_OWNER?.trim();
const repo = process.env.E2E_REPO?.trim();
const expectedId = process.env.E2E_REPO_ID?.trim();
const token = process.env.E2E_TOKEN;
const branch = process.env.E2E_BRANCH;
if (!owner || !repo || !token || !branch || !/^[1-9][0-9]*$/u.test(expectedId ?? "")) throw new Error("Incomplete E2E cleanup configuration.");
const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const encodeRef = value => value.split("/").map(encodeURIComponent).join("/");
async function body(response) { return await response.text(); }
function exactMissing(status, text) {
  if (status === 404) return true;
  if (status !== 422) return false;
  try { return JSON.parse(text).message === "Reference does not exist"; } catch { return false; }
}
async function resolveTarget() {
  const route = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const response = await fetch(route, { headers });
  const text = await body(response);
  if (response.status !== 200) throw new Error(`Cannot resolve cleanup target: HTTP ${response.status} ${text}`);
  const metadata = JSON.parse(text);
  const actualId = String(metadata.id ?? "");
  if (actualId !== expectedId) throw new Error("Cleanup target differs from pinned E2E_REPO_ID.");
  if (actualId === process.env.SOURCE_REPOSITORY_ID) throw new Error("Cleanup target equals source repository.");
  if (!metadata.full_name || !metadata.default_branch || branch === metadata.default_branch) throw new Error("Unsafe cleanup target metadata.");
  const [canonicalOwner, canonicalRepo, ...extra] = metadata.full_name.split("/");
  if (!canonicalOwner || !canonicalRepo || extra.length) throw new Error("Invalid cleanup target full_name.");
  const base = `https://api.github.com/repos/${encodeURIComponent(canonicalOwner)}/${encodeURIComponent(canonicalRepo)}`;
  const defaultResponse = await fetch(`${base}/git/ref/heads/${encodeRef(metadata.default_branch)}`, { headers });
  const defaultText = await body(defaultResponse);
  if (defaultResponse.status !== 200) throw new Error(`Cannot prove cleanup Git-ref capability: HTTP ${defaultResponse.status} ${defaultText}`);
  const defaultRef = JSON.parse(defaultText);
  if (!defaultRef.object?.sha) throw new Error("Cleanup default ref lacks commit SHA.");
  return { base };
}
if (branch !== `obsidian-sync-e2e/run-${process.env.GITHUB_RUN_ID}`) throw new Error("Cleanup branch does not match workflow run ID.");
let { base } = await resolveTarget();
const exact = () => `${base}/git/refs/heads/${encodeRef(branch)}`;
const before = await fetch(exact(), { headers });
const beforeText = await body(before);
if (!exactMissing(before.status, beforeText)) {
  if (before.status !== 200) throw new Error(`Cannot inspect cleanup ref: HTTP ${before.status} ${beforeText}`);
  const deleted = await fetch(exact(), { method: "DELETE", headers });
  const deletedText = await body(deleted);
  if (deleted.status !== 204 && !exactMissing(deleted.status, deletedText)) throw new Error(`Cannot remove cleanup ref: HTTP ${deleted.status} ${deletedText}`);
}
for (let attempt = 1; attempt <= 3; attempt++) {
  ({ base } = await resolveTarget());
  const verify = await fetch(exact(), { headers });
  const verifyText = await body(verify);
  if (exactMissing(verify.status, verifyText)) process.exit(0);
  if (verify.status !== 200) throw new Error(`Cannot verify cleanup ref absence: HTTP ${verify.status} ${verifyText}`);
  if (attempt < 3) await sleep(attempt * 2_000);
}
throw new Error(`Disposable E2E branch still exists after cleanup attempts: ${branch}`);
```

- [ ] **Step 9: Assemble the committed workflow**

Replace every `Insert ... verbatim` marker from Step 3 with the exact corresponding code from Steps 4–8. The committed `.github/workflows/github-e2e-live.yml` must contain **zero** `Insert ` markers and zero job-level `env:` blocks.

- [ ] **Step 10: Verify and commit**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-live-workflow-contract
node scripts/run-tests.mjs --tier=feasibility --filter=github-actions-pinning
corepack pnpm test:feasibility
corepack pnpm test:github-e2e:compile
```

Expected: PASS.

```bash
git add .github/workflows/github-e2e-live.yml tests/feasibility/github-e2e-live-workflow-contract.test.mjs
git commit -m "ci: run live github e2e from verified ci bundles"
```

---

## Task 6: Update Maintainer Flow and Manual Cleanup

**Files:**
- Modify: `docs/github-e2e.md`
- Modify: `docs/releasing.md`

- [ ] **Step 1: Update local configuration exactly**

```text
GITHUB_E2E_OWNER=owner
GITHUB_E2E_REPO=dedicated-disposable-repository
GITHUB_E2E_EXPECTED_REPO_ID=123456789
GITHUB_E2E_BRANCH=local-v4-e2e
GITHUB_E2E_TOKEN=<credential scoped to that repository>
```

State that expected numeric ID is mandatory in credentialed local mode. Local `pnpm test:github-e2e:quick` remains compile+run convenience; release-qualifying Actions consumes CI-precompiled bundles on a fresh runner.

- [ ] **Step 2: Document environment setup exactly**

```text
Settings -> Environments -> github-e2e
Deployment branches and tags -> Selected branches and tags
Allowed branch -> master
Allowed tags -> none
Variable: E2E_OWNER
Variable: E2E_REPO
Variable: E2E_REPO_ID
Secret: E2E_TOKEN
```

Warn not to choose `Protected branches only` while `master` has no branch-protection rule. State `E2E_REPO_ID` is identity authority and owner/repo is routing.

- [ ] **Step 3: Replace manual cleanup with guarded invariant**

The documented cleanup command/script must perform this exact sequence before branch removal:

```text
resolve E2E_OWNER/E2E_REPO
require resolved numeric ID == maintainer-known expected ID
require resolved ID != source repository ID
derive obsidian-sync-e2e/run-<RUN_ID>
require branch != actual default_branch
GET actual default-branch Git ref and require 200 + SHA
GET exact disposable ref
DELETE only if present
GET actual default-branch Git ref again and require 200 + SHA
GET exact disposable ref and require recognized absence
```

Do not document blind `204/404 == success` logic.

- [ ] **Step 4: Document cohesive rerun semantics**

```text
If cleanup fails, Re-run failed jobs may be used to remove residue safely.
That cleanup-only attempt is not release qualification.
For release qualification, use Re-run all jobs so the new current attempt runs qualify, persists a new receipt, executes bundles, and completes cleanup.
```

- [ ] **Step 5: Update Child-B portion of releasing runbook only**

```text
ordinary CI exact master/current attempt succeeds
-> current github-e2e-input artifact exists
-> GitHub E2E Live current attempt consumes it
-> same-attempt receipt persists before target mutation
-> qualify succeeds
-> cleanup succeeds in the same current attempt
```

Leave Stable Release internals for Child A.

- [ ] **Step 6: Verify and commit**

```bash
corepack pnpm test:feasibility
corepack pnpm test:github-e2e:compile
```

Expected: PASS.

```bash
git add docs/github-e2e.md docs/releasing.md
git commit -m "docs: harden live github e2e runbook"
```

---

## Task 7: Final Verification and Exact-Master Qualification

**Files:** No planned source changes. Any discovered defect gets a failing regression and a focused fix commit.

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

Expected: all PASS. If environment/network prevents execution, record the exact failure and do not claim local success.

- [ ] **Step 2: Verify scope boundary**

```text
no Child-C publication-race type/retry implementation
no Child-A Stable Release redesign beyond Action pins
no checkout/install/build/compile in live qualify
no job-level target credential
no write-capable source GITHUB_TOKEN
all external Actions full-SHA pinned
all three credentialed suites use target-safety.ts
```

- [ ] **Step 3: Push implementation commits and require branch/PR CI**

Keep the TDD commits above as reviewable units. GitHub remains source of truth.

- [ ] **Step 4: Verify one-time `github-e2e` environment settings**

Confirm in GitHub UI when connector APIs cannot prove them:

```text
environment exists
Selected branches/tags allows master only
E2E_OWNER/E2E_REPO route to initialized disposable repository
E2E_REPO_ID equals its numeric repository ID
E2E_TOKEN mutable scope is limited to that target repository
actual target default branch is readable and not the run-derived branch
```

- [ ] **Step 5: Merge after review and qualify exact final master**

For final master `M`, require newest exact-SHA ordinary CI push run/current attempt successful and artifact:

```text
github-e2e-input-M-<ci-run-id>-<ci-current-attempt>
```

exists/unexpired. Dispatch GitHub E2E Live on `master`.

Require current live attempt:

```text
qualify executed + success
receipt github-e2e-target-<live-run-id>-<same-attempt> exists
receipt source SHA = M
receipt target repository ID = pinned E2E_REPO_ID
receipt CI run/attempt/artifact = current authoritative CI input
cleanup executed + success in that same attempt
```

Do not dispatch Stable Release in Child B.

- [ ] **Step 6: If cleanup fails, keep partial rerun maintenance-only**

Use `Re-run failed jobs` only to clean residue if useful. Do not present that attempt as release qualification. Then use `Re-run all jobs` and require the new current attempt to satisfy all cohesive conditions.

- [ ] **Step 7: Record handoff evidence**

```text
implementation commit SHA
local commands actually executed/results
CI run ID/current attempt/result
live run ID/current attempt
qualify result
same-attempt receipt artifact identity
cleanup result
manually verified environment settings, if any
```

---

## Self-Review Coverage

- CI-produced executable artifact: Task 2.
- Fresh no-build credentialed execution: Task 5.
- Pinned target identity + ref capability: Tasks 3–5.
- Full-SHA external Action pinning: Task 1.
- Shared destructive safety: Tasks 3–4.
- Receipt before mutation: Task 5.
- Cohesive-attempt qualification/rerun UX: Tasks 5–7.
- Local/manual safety: Tasks 4 and 6.
- No Child-C retry implementation: Global Constraints + Tasks 4/7.
- Exact final-master evidence: Task 7.

This plan deliberately does not depend on old-attempt artifact visibility, cross-attempt job outputs, historical-success fallback, unbounded cleanup retries, or release-time source rebuilds.
