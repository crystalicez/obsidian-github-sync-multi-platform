# Live GitHub E2E Safety Final Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute exact CI-produced real-GitHub E2E bundles on a fresh credentialed runner against one pinned disposable repository, with safe cleanup and release qualification bound to one cohesive current workflow attempt.

**Architecture:** Ordinary read-only `ci.yml` is the only compiler of the three release-qualifying live-E2E bundles. `github-e2e-live.yml` becomes a no-checkout/no-install/no-build consumer: it selects the newest exact-SHA CI run/current attempt, validates the exact artifact, proves a pinned numeric target identity, persists a same-attempt provenance receipt before target mutation, executes only the three fixed verified bundles, and independently re-proves the pinned target before cleanup. Release qualification never mixes workflow attempts: the current live attempt must contain successful `qualify`, a valid same-attempt receipt, and successful `cleanup`.

**Tech Stack:** Node.js `v22.11.0`, TypeScript, ESM, esbuild, Node `node:test`, pnpm `9.12.3`, GitHub Actions, GitHub REST APIs, Python standard-library `zipfile`, full-SHA-pinned external Actions.

**Spec:** `docs/superpowers/specs/2026-08-30-live-github-e2e-safety-design.md`

## Global Constraints

- Approved design baseline: `35e98cea924702293bde62d064a83d52eca6d898`. If `master` materially changes before execution, rebase and re-review affected assumptions before coding.
- CI is the sole compiler of release-qualifying E2E bundles.
- Live `qualify` must not checkout repository code, run pnpm/npm, install project dependencies, build, or compile.
- Source `GITHUB_TOKEN` remains read-only: `actions: read`, `contents: read`.
- `E2E_TOKEN` is step-scoped and its mutable repository scope is limited to the dedicated disposable target.
- `E2E_REPO_ID` is mandatory pinned target identity. `E2E_OWNER/E2E_REPO` are routing only.
- Release-qualifying branch is exactly `obsidian-sync-e2e/run-${GITHUB_RUN_ID}`.
- Target repository must have an initialized readable default branch, and the disposable branch must differ from it.
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

- `scripts/github-e2e-input.mjs` — deterministic source-side bundle producer + provenance manifest writer.
- `tests/github-e2e/support/target-safety.ts` — shared target identity/ref-capability/reset authority bundled into each live suite.
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
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/github-e2e-live.yml`
- Modify: `.github/workflows/pre-release.yml`
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: every `.yml`/`.yaml` file under `.github/workflows/`.
- Produces: repository invariant `external uses => owner/repo@<40 lowercase hex commit SHA>`.

- [ ] **Step 1: Write the failing static contract**

Create `tests/feasibility/github-actions-pinning.test.mjs`:

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
  const failures = [];
  const names = (await readdir(workflowDir)).filter(name => /\.ya?ml$/u.test(name)).sort();
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

- [ ] **Step 2: Run the focused test and verify red state**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-actions-pinning
```

Expected: FAIL listing mutable refs including `actions/checkout@v6`, `actions/setup-node@v6`, `actions/upload-artifact@v4`, and `pnpm/action-setup@v4`.

- [ ] **Step 3: Replace mutable refs with the verified commits**

Use these exact refs wherever those Actions already appear:

```yaml
uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
```

Do not otherwise redesign `pre-release.yml` or `release.yml` in this task.

- [ ] **Step 4: Run focused and complete feasibility gates**

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

## Task 2: Make CI Produce the Exact Live-E2E Input Artifact

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

CLI additions to `scripts/run-github-e2e.mjs`:

```text
--out-dir=<path>
--write-input-manifest
```

CI artifact name:

```text
github-e2e-input-${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

Exact artifact logical entries:

```text
github-e2e-input.json
v4-real-github-e2e.test.mjs
v4-copy-contract-github-e2e.test.mjs
v4-encrypted-external-mutation.test.mjs
```

- [ ] **Step 1: Extend compile-only regression before implementation**

In `tests/feasibility/github-e2e-compile-cli.test.mjs`, retain the existing shell-independent test and add:

```js
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

test("compile-only ignores target env files and writes only fixed bundles", async () => {
  const outDir = await mkdtemp(resolve(tmpdir(), "github-e2e-compile-"));
  await writeFile(resolve(outDir, "stale.txt"), "stale\n");
  const env = {
    ...process.env,
    GITHUB_E2E_ENV_FILE: resolve(outDir, "intentionally-missing.env"),
  };
  delete env.GITHUB_E2E_OWNER;
  delete env.GITHUB_E2E_REPO;
  delete env.GITHUB_E2E_BRANCH;
  delete env.GITHUB_E2E_TOKEN;
  delete env.GITHUB_E2E_EXPECTED_REPO_ID;

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

- [ ] **Step 2: Write producer-manifest tests before implementation**

Create `tests/feasibility/github-e2e-input.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  GITHUB_E2E_BUNDLES,
  writeGitHubE2EInputManifest,
} from "../../scripts/github-e2e-input.mjs";

async function bundleDir() {
  const outDir = await mkdtemp(resolve(tmpdir(), "github-e2e-input-test-"));
  for (const name of GITHUB_E2E_BUNDLES) await writeFile(resolve(outDir, name), `bundle:${name}\n`);
  return outDir;
}

const goodEnv = {
  GITHUB_REPOSITORY_ID: "1282135059",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "1234",
  GITHUB_RUN_ATTEMPT: "2",
};

test("manifest binds exact fixed bundles to CI run attempt", async () => {
  const outDir = await bundleDir();
  await writeGitHubE2EInputManifest({ outDir, env: goodEnv, nodeVersion: "v22.11.0" });
  assert.deepEqual((await readdir(outDir)).sort(), ["github-e2e-input.json", ...GITHUB_E2E_BUNDLES].sort());
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
  assert.ok(manifest.bundles.every(item => Number.isSafeInteger(item.size) && item.size > 0));
  assert.ok(manifest.bundles.every(item => /^[0-9a-f]{64}$/u.test(item.sha256)));
});

test("manifest rejects invalid producer identity", async () => {
  for (const [field, value] of [
    ["GITHUB_REPOSITORY_ID", "0"],
    ["GITHUB_SHA", "not-a-sha"],
    ["GITHUB_RUN_ID", "0"],
    ["GITHUB_RUN_ATTEMPT", "0"],
  ]) {
    const outDir = await bundleDir();
    await assert.rejects(
      writeGitHubE2EInputManifest({ outDir, env: { ...goodEnv, [field]: value }, nodeVersion: "v22.11.0" }),
      new RegExp(field, "u"),
    );
  }
});

test("manifest rejects missing, empty, or extra bundle entries", async () => {
  {
    const outDir = await bundleDir();
    await writeFile(resolve(outDir, GITHUB_E2E_BUNDLES[0]), "");
    await assert.rejects(writeGitHubE2EInputManifest({ outDir, env: goodEnv, nodeVersion: "v22.11.0" }), /empty/u);
  }
  {
    const outDir = await bundleDir();
    await writeFile(resolve(outDir, "unexpected.txt"), "unexpected\n");
    await assert.rejects(writeGitHubE2EInputManifest({ outDir, env: goodEnv, nodeVersion: "v22.11.0" }), /unexpected entries/u);
  }
});

test("manifest rejects invalid Node version", async () => {
  const outDir = await bundleDir();
  await assert.rejects(writeGitHubE2EInputManifest({ outDir, env: goodEnv, nodeVersion: "22" }), /Node version/u);
});
```

- [ ] **Step 3: Run the focused tests and verify red state**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-compile-cli
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-input
```

Expected: FAIL because the producer module and output CLI do not exist.

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

export const GITHUB_E2E_BUNDLES = Object.freeze(
  GITHUB_E2E_ENTRY_POINTS.map(value => value.split("/").at(-1).replace(/\.ts$/u, ".mjs")),
);

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

- [ ] **Step 5: Refactor `scripts/run-github-e2e.mjs`**

Add import:

```js
import { compileGitHubE2EBundles, writeGitHubE2EInputManifest } from "./github-e2e-input.mjs";
```

Determine compile mode before env-file loading:

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

Replace local esbuild loop with:

```js
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

Non-compile local mode continues serial `node --test --test-concurrency=1` with `outfiles`.

- [ ] **Step 6: Update CI producer**

Replace current compile step with:

```yaml
- name: Compile real GitHub E2E harness
  run: >-
    node scripts/run-github-e2e.mjs
    --compile-only
    --out-dir=.tmp/github-e2e-input
    --write-input-manifest
```

After package validation add:

```yaml
- name: Upload release-qualifying GitHub E2E input
  if: github.event_name == 'push' && github.ref == 'refs/heads/master'
  uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  with:
    name: github-e2e-input-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}
    path: .tmp/github-e2e-input
    if-no-files-found: error
```

Keep current `plugin-${{ github.sha }}` artifact unchanged in Child B.

- [ ] **Step 7: Add CI contract assertions**

Append to `tests/feasibility/github-e2e-input.test.mjs`:

```js
import { readFile as readTextFile } from "node:fs/promises";

test("CI publishes live E2E input only for master pushes", async () => {
  const ci = await readTextFile(resolve(".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /--out-dir=\.tmp\/github-e2e-input/u);
  assert.match(ci, /--write-input-manifest/u);
  assert.match(ci, /github-e2e-input-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(ci, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/master'/u);
});
```

- [ ] **Step 8: Verify green state**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-compile-cli
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-input
corepack pnpm test:github-e2e:compile
```

Expected: PASS without any target credential.

- [ ] **Step 9: Commit**

```bash
git add scripts/github-e2e-input.mjs scripts/run-github-e2e.mjs tests/feasibility/github-e2e-compile-cli.test.mjs tests/feasibility/github-e2e-input.test.mjs .github/workflows/ci.yml
git commit -m "test: produce provenance-bound github e2e bundles"
```

---

## Task 3: Centralize Target Identity and Branch Reset Safety

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

- [ ] **Step 1: Write deterministic mocked REST tests**

Create `tests/feasibility/github-e2e-target-safety.test.ts` with this base harness:

```ts
import assert from "node:assert/strict"
import test from "node:test"
import {
  readGitHubE2ETargetEnvironment,
  resetGitHubE2EDisposableBranch,
  resolveGitHubE2ETarget,
  type GitHubE2EFetch,
  type GitHubE2ETargetEnvironment,
} from "../github-e2e/support/target-safety"

function scriptedFetch(steps: Array<{ method?: string; path: string; status: number; body?: unknown }>): GitHubE2EFetch {
  let index = 0
  return async (url, init = {}) => {
    const step = steps[index++]
    assert.ok(step, `unexpected request ${(init.method ?? "GET").toUpperCase()} ${url}`)
    assert.equal((init.method ?? "GET").toUpperCase(), step.method ?? "GET")
    assert.equal(new URL(url).pathname, step.path)
    return new Response(step.body === undefined ? "" : JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json" },
    })
  }
}

const base: GitHubE2ETargetEnvironment = {
  owner: "TargetOwner",
  repo: "TargetRepo",
  branch: "obsidian-sync-e2e/run-77",
  token: "redacted-test-token",
  expectedRepositoryId: "222",
  sourceRepositoryId: "111",
  requiredBranch: "obsidian-sync-e2e/run-77",
}

const metadata = { id: 222, full_name: "CanonicalOwner/CanonicalRepo", default_branch: "trunk" }
const defaultRef = { object: { sha: "d".repeat(40) } }
```

Add these exact tests:

```ts
test("rejects a route resolving to the source repository ID", async () => {
  await assert.rejects(resolveGitHubE2ETarget({ ...base, expectedRepositoryId: "111" }, scriptedFetch([
    { path: "/repos/TargetOwner/TargetRepo", status: 200, body: { ...metadata, id: 111 } },
  ])), /must not be the source repository/u)
})

test("rejects resolved target ID that differs from pinned ID", async () => {
  await assert.rejects(resolveGitHubE2ETarget(base, scriptedFetch([
    { path: "/repos/TargetOwner/TargetRepo", status: 200, body: { ...metadata, id: 333 } },
  ])), /pinned repository ID/u)
})

test("rejects actual default branch even when named trunk", async () => {
  await assert.rejects(resolveGitHubE2ETarget({ ...base, branch: "trunk", requiredBranch: undefined }, scriptedFetch([
    { path: "/repos/TargetOwner/TargetRepo", status: 200, body: metadata },
  ])), /default branch/u)
})

test("rejects Actions branch mismatch", async () => {
  await assert.rejects(resolveGitHubE2ETarget({ ...base, branch: "other" }, scriptedFetch([
    { path: "/repos/TargetOwner/TargetRepo", status: 200, body: metadata },
  ])), /required workflow branch/u)
})

test("metadata failure fails closed", async () => {
  await assert.rejects(resolveGitHubE2ETarget(base, scriptedFetch([
    { path: "/repos/TargetOwner/TargetRepo", status: 404, body: { message: "Not Found" } },
  ])), /Cannot inspect GitHub E2E repository/u)
})

test("unreadable default ref fails closed", async () => {
  await assert.rejects(resolveGitHubE2ETarget(base, scriptedFetch([
    { path: "/repos/TargetOwner/TargetRepo", status: 200, body: metadata },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/ref/heads/trunk", status: 404, body: { message: "Not Found" } },
  ])), /Git-ref read capability/u)
})

test("exact disposable 404 is accepted only after default-ref capability", async () => {
  const resolved = await resetGitHubE2EDisposableBranch(base, scriptedFetch([
    { path: "/repos/TargetOwner/TargetRepo", status: 200, body: metadata },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/ref/heads/trunk", status: 200, body: defaultRef },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/refs/heads/obsidian-sync-e2e/run-77", status: 404, body: { message: "Not Found" } },
  ]))
  assert.equal(resolved.repositoryId, "222")
})

test("arbitrary 422 is not absence", async () => {
  await assert.rejects(resetGitHubE2EDisposableBranch(base, scriptedFetch([
    { path: "/repos/TargetOwner/TargetRepo", status: 200, body: metadata },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/ref/heads/trunk", status: 200, body: defaultRef },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/refs/heads/obsidian-sync-e2e/run-77", status: 422, body: { message: "Validation Failed" } },
  ])), /Cannot inspect GitHub E2E disposable ref/u)
})

test("recognized 422 missing reference is absence after capability", async () => {
  await resetGitHubE2EDisposableBranch(base, scriptedFetch([
    { path: "/repos/TargetOwner/TargetRepo", status: 200, body: metadata },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/ref/heads/trunk", status: 200, body: defaultRef },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/refs/heads/obsidian-sync-e2e/run-77", status: 422, body: { message: "Reference does not exist" } },
  ]))
})

test("concurrent already-absent delete still performs final capability and absence proof", async () => {
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

test("post-delete loss of default-ref capability fails", async () => {
  await assert.rejects(resetGitHubE2EDisposableBranch(base, scriptedFetch([
    { path: "/repos/TargetOwner/TargetRepo", status: 200, body: metadata },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/ref/heads/trunk", status: 200, body: defaultRef },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/refs/heads/obsidian-sync-e2e/run-77", status: 200, body: { object: { sha: "a".repeat(40) } } },
    { method: "DELETE", path: "/repos/CanonicalOwner/CanonicalRepo/git/refs/heads/obsidian-sync-e2e/run-77", status: 204 },
    { path: "/repos/TargetOwner/TargetRepo", status: 200, body: metadata },
    { path: "/repos/CanonicalOwner/CanonicalRepo/git/ref/heads/trunk", status: 403, body: { message: "Forbidden" } },
  ])), /Git-ref read capability/u)
})

test("credentialed environment requires numeric expected repository ID", () => {
  assert.throws(() => readGitHubE2ETargetEnvironment({
    GITHUB_E2E_OWNER: "owner",
    GITHUB_E2E_REPO: "repo",
    GITHUB_E2E_BRANCH: "local-e2e",
    GITHUB_E2E_TOKEN: "secret",
  }), /GITHUB_E2E_EXPECTED_REPO_ID/u)
  assert.throws(() => readGitHubE2ETargetEnvironment({
    GITHUB_E2E_OWNER: "owner",
    GITHUB_E2E_REPO: "repo",
    GITHUB_E2E_BRANCH: "local-e2e",
    GITHUB_E2E_TOKEN: "secret",
    GITHUB_E2E_EXPECTED_REPO_ID: "repo-name",
  }), /numeric GitHub repository ID/u)
})
```

- [ ] **Step 2: Run the focused test and verify red state**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-target-safety
```

Expected: FAIL because `target-safety.ts` does not exist.

- [ ] **Step 3: Implement `tests/github-e2e/support/target-safety.ts` environment and resolution layer**

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

export async function resolveGitHubE2ETarget(
  input: GitHubE2ETargetEnvironment,
  request: GitHubE2EFetch = fetch,
): Promise<ResolvedGitHubE2ETarget> {
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

- [ ] **Step 4: Implement absence/reset without consuming successful response bodies twice**

Append to the same file:

```ts
async function recognizedMissingRef(response: Response): Promise<boolean> {
  if (response.status === 404) {
    await response.arrayBuffer().catch(() => undefined)
    return true
  }
  if (response.status !== 422) return false
  const text = await response.text()
  try { return (JSON.parse(text) as { message?: string }).message === "Reference does not exist" }
  catch { return false }
}

export async function resetGitHubE2EDisposableBranch(
  input: GitHubE2ETargetEnvironment,
  request: GitHubE2EFetch = fetch,
): Promise<ResolvedGitHubE2ETarget> {
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

The order `if (response.status !== 422) return false` occurs **before** `response.text()` so a normal 200 response body remains unread for the caller. Keep this regression-protecting detail.

- [ ] **Step 5: Run focused safety tests**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-target-safety
```

Expected: PASS with no real GitHub request.

- [ ] **Step 6: Commit**

```bash
git add tests/github-e2e/support/target-safety.ts tests/feasibility/github-e2e-target-safety.test.ts
git commit -m "test: centralize github e2e target safety"
```

---

## Task 4: Migrate Every Credentialed Suite and the Local Runner

**Files:**
- Create: `tests/feasibility/github-e2e-suite-safety-contract.test.mjs`
- Modify: `tests/github-e2e/v4-real-github-e2e.test.ts`
- Modify: `tests/github-e2e/v4-copy-contract-github-e2e.test.ts`
- Modify: `tests/github-e2e/v4-encrypted-external-mutation.test.ts`
- Modify: `scripts/run-github-e2e.mjs`
- Modify: `tests/feasibility/github-e2e-compile-cli.test.mjs`

**Interfaces:**
- Credentialed local execution requires `GITHUB_E2E_EXPECTED_REPO_ID`.
- Actions execution additionally provides `GITHUB_E2E_SOURCE_REPO_ID` and `GITHUB_E2E_REQUIRED_BRANCH`.
- Existing scenario logic and Child-C-owned stale-ref retry policy remain unchanged.

- [ ] **Step 1: Write suite migration static test**

Create `tests/feasibility/github-e2e-suite-safety-contract.test.mjs`:

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

test("all credentialed live suites delegate destructive target safety", async () => {
  for (const file of suites) {
    const text = await readFile(resolve(file), "utf8");
    assert.match(text, /\.\/support\/target-safety/u, file);
    assert.match(text, /readGitHubE2ETargetEnvironment/u, file);
    assert.match(text, /resolveGitHubE2ETarget/u, file);
    assert.match(text, /resetGitHubE2EDisposableBranch/u, file);
    assert.doesNotMatch(text, /async function deleteTestBranch/u, file);
    assert.doesNotMatch(text, /const forbiddenBranches/u, file);
  }
});
```

- [ ] **Step 2: Add local runner missing-ID regression**

Append to `github-e2e-compile-cli.test.mjs`:

```js
test("credentialed runner requires expected target repository ID before execution", () => {
  const env = { ...process.env };
  delete env.GITHUB_E2E_ENV_FILE;
  env.GITHUB_E2E_OWNER = "owner";
  env.GITHUB_E2E_REPO = "repo";
  env.GITHUB_E2E_BRANCH = "local-e2e";
  env.GITHUB_E2E_TOKEN = "test-token";
  delete env.GITHUB_E2E_EXPECTED_REPO_ID;

  const result = spawnSync(process.execPath, [resolve("scripts/run-github-e2e.mjs")], {
    cwd: resolve("."), env, encoding: "utf8",
  });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /GITHUB_E2E_EXPECTED_REPO_ID/u);
});
```

- [ ] **Step 3: Run tests and verify red state**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-suite-safety-contract
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-compile-cli
```

Expected: FAIL because suites still own reset logic and runner does not require expected ID.

- [ ] **Step 4: Require expected repository ID in non-compile runner**

Set:

```js
const required = [
  "GITHUB_E2E_OWNER",
  "GITHUB_E2E_REPO",
  "GITHUB_E2E_BRANCH",
  "GITHUB_E2E_TOKEN",
  "GITHUB_E2E_EXPECTED_REPO_ID",
];
```

Keep compile-only mode completely credential-free.

- [ ] **Step 5: Migrate each live suite to shared helper**

At top of each suite add:

```ts
import {
  encodeGitHubE2ERefPath,
  readGitHubE2ETargetEnvironment,
  resetGitHubE2EDisposableBranch,
  resolveGitHubE2ETarget,
} from "./support/target-safety"
```

Replace suite-specific environment/config bootstrap with:

```ts
const targetEnvironment = readGitHubE2ETargetEnvironment()
const initialTarget = await resolveGitHubE2ETarget(targetEnvironment)
const github = initialTarget.config
```

Replace every scenario-start reset and `after()` cleanup with:

```ts
await resetGitHubE2EDisposableBranch(targetEnvironment)
```

Use:

```ts
encodeGitHubE2ERefPath(github.branch)
```

where an external-interference helper requires the encoded branch path.

Remove each suite's duplicate `forbiddenBranches`, local env parser/config builder used only for target safety, `deleteTestBranch`, and duplicate deletion polling. Keep scenario-specific Git requests used to inject/read test state.

Do **not** modify the existing main/copy wrappers' `/branch head changed|stale ref/i` retry blocks or `runState.conflictCopyStages?.clear()`; Child C owns that change.

- [ ] **Step 6: Verify migration**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-suite-safety-contract
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-compile-cli
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-target-safety
corepack pnpm test:github-e2e:compile
```

Expected: PASS without a real target credential.

- [ ] **Step 7: Commit**

```bash
git add scripts/run-github-e2e.mjs tests/github-e2e tests/feasibility/github-e2e-suite-safety-contract.test.mjs tests/feasibility/github-e2e-compile-cli.test.mjs
git commit -m "test: enforce pinned live e2e repository identity"
```

---

## Task 5: Rewrite `GitHub E2E Live` as a Verified CI-Artifact Executor

**Files:**
- Create: `tests/feasibility/github-e2e-live-workflow-contract.test.mjs`
- Modify: `.github/workflows/github-e2e-live.yml`

**Interfaces:**

Environment configuration:

```text
vars.E2E_OWNER
vars.E2E_REPO
vars.E2E_REPO_ID
secrets.E2E_TOKEN
```

Same-attempt receipt artifact:

```text
github-e2e-target-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

Receipt contains one file: `github-e2e-target.json`.

- [ ] **Step 1: Write failing workflow contract**

Create `tests/feasibility/github-e2e-live-workflow-contract.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workflow = resolve(".github/workflows/github-e2e-live.yml");

test("live workflow executes verified CI bundles without building source", async () => {
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

test("receipt is blocking and precedes live target execution", async () => {
  const text = await readFile(workflow, "utf8");
  const upload = text.indexOf("Upload same-attempt qualification receipt");
  const execute = text.indexOf("Run verified real GitHub E2E bundles");
  assert.ok(upload >= 0 && execute > upload);
  assert.match(text, /github-e2e-target-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  assert.doesNotMatch(text.slice(upload, execute), /continue-on-error:\s*true/u);
});

test("cleanup re-proves pinned target and does not depend on qualify outputs", async () => {
  const text = await readFile(workflow, "utf8");
  assert.match(text, /if:\s*always\(\)/u);
  assert.ok((text.match(/environment:\s*github-e2e/gu) ?? []).length >= 2);
  assert.doesNotMatch(text, /needs\.qualify\.outputs/u);
  assert.match(text, /cleanup-only rerun may remove residue but is not release qualification/u);
});
```

- [ ] **Step 2: Run focused test and verify red state**

```bash
node scripts/run-tests.mjs --tier=feasibility --filter=github-e2e-live-workflow-contract
```

Expected: FAIL because current workflow checks out/builds and has job-level target secret state.

- [ ] **Step 3: Replace workflow permissions/skeleton**

Start the rewritten workflow with:

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
      # steps from this task

  cleanup:
    name: cleanup
    if: always()
    needs: qualify
    runs-on: ubuntu-latest
    timeout-minutes: 5
    environment: github-e2e
    steps:
      # cleanup step from this task
```

Do not add job-level `env:` blocks.

- [ ] **Step 4: Implement newest exact-SHA CI/current-attempt selector**

Add `qualify` step named `Select authoritative CI E2E input`, id `ci`, with only source read token. Inline Node logic must use:

```js
const { appendFileSync } = require("node:fs");
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
  const byTime = Date.parse(right.created_at) - Date.parse(left.created_at);
  if (byTime) return byTime;
  const a = BigInt(String(left.id));
  const b = BigInt(String(right.id));
  return a === b ? 0 : b > a ? 1 : -1;
}

const master = await api("/git/ref/heads/master");
if (process.env.GITHUB_REF !== "refs/heads/master" || master.object?.sha !== process.env.GITHUB_SHA) {
  throw new Error("Live qualification source is not exact current master.");
}

const runs = (await listAll(`/actions/workflows/ci.yml/runs?head_sha=${process.env.GITHUB_SHA}&event=push`, "workflow_runs"))
  .filter(run => run.head_branch === "master" && run.head_sha === process.env.GITHUB_SHA)
  .sort(newest);
const run = runs[0];
if (!run || run.status !== "completed" || run.conclusion !== "success") {
  throw new Error("Newest exact-SHA CI run is not successful.");
}
const attempt = Number(run.run_attempt);
if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Invalid CI run attempt.");

const jobs = await listAll(`/actions/runs/${run.id}/attempts/${attempt}/jobs`, "jobs");
const verifies = jobs.filter(job => job.name === "verify");
if (verifies.length !== 1 || verifies[0].status !== "completed" || verifies[0].conclusion !== "success") {
  throw new Error("CI verify job is not uniquely successful in the current run attempt.");
}

const artifactName = `github-e2e-input-${process.env.GITHUB_SHA}-${run.id}-${attempt}`;
const artifacts = await listAll(`/actions/runs/${run.id}/artifacts`, "artifacts");
const matches = artifacts.filter(item => item.name === artifactName && item.expired === false);
if (matches.length !== 1) throw new Error(`Expected exactly one current CI E2E artifact: ${artifactName}`);
const artifact = matches[0];

const source = await api(`/contents/.node-version?ref=${process.env.GITHUB_SHA}`);
const nodeVersion = Buffer.from(source.content ?? "", "base64").toString("utf8").trim();
if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(nodeVersion)) throw new Error("Exact source .node-version is invalid.");

for (const [name, value] of Object.entries({
  run_id: String(run.id),
  run_attempt: String(attempt),
  artifact_id: String(artifact.id),
  artifact_digest: artifact.digest ?? "",
  node_version: nodeVersion,
})) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
```

Step YAML environment:

```yaml
env:
  GH_TOKEN: ${{ github.token }}
```

- [ ] **Step 5: Download and validate artifact before exposing target secret**

Add step `Download authoritative CI E2E artifact` with:

```yaml
env:
  GH_TOKEN: ${{ github.token }}
  ARTIFACT_ID: ${{ steps.ci.outputs.artifact_id }}
run: |
  set -euo pipefail
  rm -rf .tmp/github-e2e-download .tmp/github-e2e-verified
  mkdir -p .tmp/github-e2e-download .tmp/github-e2e-verified
  gh api "repos/$GITHUB_REPOSITORY/actions/artifacts/$ARTIFACT_ID/zip" > .tmp/github-e2e-download/input.zip
```

If `steps.ci.outputs.artifact_digest` is nonempty, add a fixed Node/Python hash check requiring `sha256:<hex>` and exact archive hash equality before opening the ZIP.

Then validate and materialize with this Python core (supply CI/source identities as env variables from step outputs/context):

```py
import hashlib, json, os
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

ARCHIVE = Path(".tmp/github-e2e-download/input.zip")
OUT = Path(".tmp/github-e2e-verified")
EXPECTED_BUNDLES = [
    "v4-real-github-e2e.test.mjs",
    "v4-copy-contract-github-e2e.test.mjs",
    "v4-encrypted-external-mutation.test.mjs",
]
EXPECTED = {"github-e2e-input.json", *EXPECTED_BUNDLES}

def reject_duplicate_pairs(pairs):
    output = {}
    for key, value in pairs:
        if key in output:
            raise ValueError(f"duplicate JSON key: {key}")
        output[key] = value
    return output

with ZipFile(ARCHIVE) as zf:
    infos = zf.infolist()
    names = [info.filename for info in infos]
    if len(names) != len(set(names)) or set(names) != EXPECTED:
        raise SystemExit("unexpected GitHub E2E artifact entries")
    by_name = {info.filename: info for info in infos}
    for info in infos:
        path = PurePosixPath(info.filename)
        mode = (info.external_attr >> 16) & 0o170000
        if path.is_absolute() or ".." in path.parts or "\\" in info.filename or info.is_dir() or mode == 0o120000:
            raise SystemExit(f"unsafe GitHub E2E artifact entry: {info.filename}")

    manifest = json.loads(zf.read("github-e2e-input.json"), object_pairs_hook=reject_duplicate_pairs)
    expected_identity = {
        "schemaVersion": 1,
        "repositoryId": os.environ["SOURCE_REPOSITORY_ID"],
        "commitSha": os.environ["SOURCE_SHA"],
        "workflowRunId": os.environ["CI_RUN_ID"],
        "workflowRunAttempt": int(os.environ["CI_RUN_ATTEMPT"]),
        "nodeVersion": os.environ["NODE_VERSION"],
    }
    for key, value in expected_identity.items():
        if manifest.get(key) != value:
            raise SystemExit(f"GitHub E2E manifest mismatch: {key}")

    bundles = manifest.get("bundles")
    if not isinstance(bundles, list) or [item.get("name") for item in bundles] != EXPECTED_BUNDLES:
        raise SystemExit("GitHub E2E manifest bundle allowlist mismatch")

    OUT.mkdir(parents=True, exist_ok=True)
    for item in bundles:
        if set(item) != {"name", "size", "sha256"}:
            raise SystemExit(f"invalid bundle manifest fields: {item.get('name')}")
        name = item["name"]
        data = zf.read(name)
        if item["size"] != len(data) or not isinstance(item["size"], int) or item["size"] <= 0:
            raise SystemExit(f"bundle size mismatch: {name}")
        digest = hashlib.sha256(data).hexdigest()
        if item["sha256"] != digest:
            raise SystemExit(f"bundle digest mismatch: {name}")
        (OUT / name).write_bytes(data)
```

Do not use `extractall()`.

- [ ] **Step 6: Set up only exact Node runtime**

```yaml
- name: Setup exact Node.js runtime
  uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
  with:
    node-version: ${{ steps.ci.outputs.node_version }}
```

No cache and no pnpm setup.

- [ ] **Step 7: Add pinned target guard with step-scoped secret**

Add step id `target`, named `Guard pinned qualification target`, with env:

```yaml
env:
  E2E_OWNER: ${{ vars.E2E_OWNER }}
  E2E_REPO: ${{ vars.E2E_REPO }}
  E2E_REPO_ID: ${{ vars.E2E_REPO_ID }}
  E2E_TOKEN: ${{ secrets.E2E_TOKEN }}
  E2E_BRANCH: obsidian-sync-e2e/run-${{ github.run_id }}
```

Inline Node must:

```js
const owner = process.env.E2E_OWNER?.trim();
const repo = process.env.E2E_REPO?.trim();
const expectedId = process.env.E2E_REPO_ID?.trim();
const token = process.env.E2E_TOKEN;
const branch = process.env.E2E_BRANCH;
if (!owner || !repo || !token || !branch || !/^[1-9][0-9]*$/u.test(expectedId ?? "")) throw new Error("Incomplete GitHub E2E target configuration.");
const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" };
async function json(url, statuses, action) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  if (!statuses.includes(response.status)) throw new Error(`${action}: HTTP ${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}
const metadata = await json(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, [200], "Cannot resolve target repository");
const actualId = String(metadata.id ?? "");
if (actualId !== expectedId) throw new Error("Target repository ID differs from pinned E2E_REPO_ID.");
if (actualId === process.env.GITHUB_REPOSITORY_ID) throw new Error("Target repository equals source repository.");
if (!metadata.full_name || !metadata.default_branch) throw new Error("Target repository metadata is incomplete.");
if (branch === metadata.default_branch) throw new Error("Disposable branch equals target default branch.");
const [canonicalOwner, canonicalRepo, ...extra] = metadata.full_name.split("/");
if (!canonicalOwner || !canonicalRepo || extra.length) throw new Error("Invalid target canonical full_name.");
const encodeRef = value => value.split("/").map(encodeURIComponent).join("/");
const defaultRef = await json(`https://api.github.com/repos/${encodeURIComponent(canonicalOwner)}/${encodeURIComponent(canonicalRepo)}/git/ref/heads/${encodeRef(metadata.default_branch)}`, [200], "Cannot prove target default-ref capability");
if (!defaultRef.object?.sha) throw new Error("Target default ref lacks commit SHA.");
const { appendFileSync } = require("node:fs");
for (const [name, value] of Object.entries({
  owner: canonicalOwner,
  repo: canonicalRepo,
  repository_id: actualId,
  default_branch: metadata.default_branch,
  branch,
})) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
```

Step must also receive `GITHUB_REPOSITORY_ID: ${{ github.repository_id }}` as a non-secret env value.

- [ ] **Step 8: Persist same-attempt receipt before target mutation**

Add a token-free step that writes `.tmp/github-e2e-receipt/github-e2e-target.json` with exactly these fields:

```json
{
  "schemaVersion": 1,
  "sourceRepositoryId": "<github.repository_id>",
  "sourceCommitSha": "<github.sha>",
  "workflowRunId": "<github.run_id>",
  "workflowRunAttempt": 1,
  "ciProducerRunId": "<ci run>",
  "ciProducerRunAttempt": 1,
  "ciE2EArtifactId": "<artifact id>",
  "ciE2EArtifactDigest": "sha256:<hex> or null",
  "targetRepositoryId": "<target id>",
  "targetFullName": "<canonical owner/repo>",
  "targetDefaultBranch": "<default branch>",
  "targetBranch": "obsidian-sync-e2e/run-<run id>"
}
```

Use workflow/step values, not user-controlled JSON. Then upload with no `continue-on-error`:

```yaml
- name: Upload same-attempt qualification receipt
  uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  with:
    name: github-e2e-target-${{ github.run_id }}-${{ github.run_attempt }}
    path: .tmp/github-e2e-receipt/github-e2e-target.json
    if-no-files-found: error
```

- [ ] **Step 9: Execute only the three verified bundles with target secret**

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

`cleanup` keeps `if: always()` and `environment: github-e2e`. Its credentialed step uses only current route vars, pinned ID, source ID, run-derived branch, and target secret. Implement the same sequence as `target-safety.ts` in fixed inline Node:

```text
resolve current E2E_OWNER/E2E_REPO
require resolved ID == E2E_REPO_ID
require resolved ID != GITHUB_REPOSITORY_ID
require branch == obsidian-sync-e2e/run-${GITHUB_RUN_ID}
require branch != current default_branch
GET current default-branch ref = 200 with SHA
GET exact disposable ref
  404 or exact 422 "Reference does not exist" => success
  200 => DELETE
  anything else => fail
DELETE result:
  204 => continue
  exact recognized absence => continue
  anything else => fail
repeat up to 3:
  re-resolve metadata + pinned ID
  re-read current default-branch ref = 200 with SHA
  GET exact disposable ref
  recognized absence => success
  200 => retry/final failure
  anything else => fail
```

Do not download a receipt and do not use `needs.qualify.outputs` as cleanup identity authority. Add this comment directly above cleanup logic:

```yaml
# A cleanup-only rerun may remove residue but is not release qualification;
# release qualification requires qualify + receipt + cleanup in one current attempt.
```

- [ ] **Step 11: Run workflow/static gates**

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

## Task 6: Update Maintainer Flow and Emergency Cleanup

**Files:**
- Modify: `docs/github-e2e.md`
- Modify: `docs/releasing.md`

**Interfaces:**

Environment setup becomes:

```text
Variable: E2E_OWNER
Variable: E2E_REPO
Variable: E2E_REPO_ID
Secret:   E2E_TOKEN
Deployment branches and tags: Selected branches and tags -> master only, no tags
```

Local credentialed mode adds:

```text
GITHUB_E2E_EXPECTED_REPO_ID=<numeric target repository ID>
```

- [ ] **Step 1: Replace local/manual configuration block in `docs/github-e2e.md`**

Document:

```text
GITHUB_E2E_OWNER=owner
GITHUB_E2E_REPO=dedicated-disposable-repository
GITHUB_E2E_EXPECTED_REPO_ID=123456789
GITHUB_E2E_BRANCH=local-v4-e2e
GITHUB_E2E_TOKEN=<credential scoped to that repository>
```

State release-qualifying credentials **require** target-repository-only mutable scope. Keep `pnpm test:github-e2e:quick` as local convenience and state that local convenience compiles+runs in one process while Actions deliberately consumes CI-precompiled bundles on a fresh runner.

- [ ] **Step 2: Replace Actions environment setup text**

Document exact UI configuration:

```text
Settings -> Environments -> github-e2e
Deployment branches and tags -> Selected branches and tags
Allowed branch -> master
Allowed tags -> none
```

Warn not to select `Protected branches only` while `master` has no branch-protection rule. Explain `E2E_REPO_ID` is authority and owner/repo is routing.

- [ ] **Step 3: Replace blind manual cleanup sample with guarded sequence**

The replacement script/instructions must require this order:

```text
known expected numeric target ID
resolve configured route metadata
require resolved ID == expected ID
derive obsidian-sync-e2e/run-<RUN_ID>
require branch != actual default branch
GET actual default-branch Git ref successfully
GET exact disposable ref
only if present: DELETE exact disposable ref
GET actual default-branch Git ref successfully again
verify exact disposable ref absent
```

No sample may accept arbitrary 404 as success before default-ref capability proof.

- [ ] **Step 4: Document cohesive rerun semantics**

Add:

```text
If cleanup fails, Re-run failed jobs may be used to remove residue safely.
That cleanup-only attempt is not release qualification.
For release qualification, choose Re-run all jobs so the new current attempt runs qualify, persists a new receipt, executes the bundles, and completes cleanup.
```

- [ ] **Step 5: Update only Child-B section of `docs/releasing.md`**

Replace live qualification description with:

```text
ordinary CI on exact master/current attempt succeeds
-> current github-e2e-input artifact exists
-> GitHub E2E Live consumes that artifact
-> same-attempt receipt persists before target mutation
-> qualify succeeds
-> cleanup succeeds in the same current attempt
```

Do not rewrite the Stable Release implementation section yet; Child A will do that.

- [ ] **Step 6: Verify docs-sensitive deterministic gates**

```bash
corepack pnpm test:feasibility
corepack pnpm test:github-e2e:compile
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add docs/github-e2e.md docs/releasing.md
git commit -m "docs: harden live github e2e runbook"
```

---

## Task 7: Verify Child B End-to-End Before Handoff

**Files:**
- No planned source change. Any defect found here gets a failing regression and a focused fix commit.

**Interfaces:**
- Produces exact deterministic/CI/live evidence for Child B.
- Does **not** dispatch Stable Release.

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

Expected: all PASS. If the environment cannot install/run, record the exact failure and do not claim local success.

- [ ] **Step 2: Inspect child-boundary diff**

Verify explicitly:

```text
no Child-C publication-race type/retry implementation
no Child-A Stable Release redesign beyond full-SHA Action pins
no checkout/install/build/compile in live qualify
no job-level target credential
no write-capable source GITHUB_TOKEN
all external Actions full-SHA pinned
all three credentialed suites use target-safety.ts
```

- [ ] **Step 3: Push every implementation commit and require branch/PR CI**

Preserve TDD commit boundaries for review. GitHub remains source of truth.

- [ ] **Step 4: Verify one-time environment configuration before live qualification**

Confirm in GitHub UI when connector cannot prove a setting:

```text
github-e2e environment exists
Selected branches/tags allows master only
E2E_OWNER/E2E_REPO route to the initialized disposable repository
E2E_REPO_ID equals its numeric GitHub repository ID
E2E_TOKEN mutable scope is limited to that target repository
actual target default branch is readable and is not the run-derived branch
```

Do not infer a setting the available API cannot read.

- [ ] **Step 5: Merge after review, then qualify exact final master SHA**

Let final master be `M`. Require newest exact-SHA CI `push` run current attempt completed/successful and artifact:

```text
github-e2e-input-M-<ci-run-id>-<ci-current-attempt>
```

exists and is unexpired. Dispatch **GitHub E2E Live** selecting `master`.

Require current live attempt:

```text
qualify executed + success
receipt github-e2e-target-<live-run-id>-<same-current-attempt> exists
receipt source SHA = M
receipt target repository ID = pinned E2E_REPO_ID
receipt CI producer run/attempt/artifact = current authoritative CI input
cleanup executed + success in that same attempt
```

Do not dispatch Stable Release in Child B.

- [ ] **Step 6: If cleanup fails, exercise maintenance-only partial rerun correctly**

Use `Re-run failed jobs` only to clean residue if useful. Confirm that partial attempt is not presented as release qualification because it lacks same-attempt `qualify` + receipt. Then use `Re-run all jobs` and require the new current attempt to satisfy all cohesive conditions before qualification is restored.

- [ ] **Step 7: Record final evidence**

Report:

```text
implementation commit SHA
local commands actually executed and results
GitHub CI run ID/current attempt/result
live E2E run ID/current attempt
qualify result
same-attempt receipt artifact identity
cleanup result
manually verified environment settings, if any
```

Never describe Child B as release-qualified without exact final-master/current-attempt evidence.

---

## Plan Self-Review Coverage

- CI-produced bundles and exact artifact: Task 2.
- Fresh no-build credentialed execution: Task 5.
- Pinned target identity/environment: Tasks 3–6.
- Full-SHA external Action pinning: Task 1.
- Shared destructive safety/default-ref capability: Tasks 3–5.
- Same-attempt receipt before mutation: Task 5.
- Cohesive current-attempt qualification/rerun UX: Tasks 5–7.
- Local/manual safety: Tasks 4 and 6.
- No Child-C retry changes: Global Constraints + Tasks 4/7.
- Exact final-master qualification evidence: Task 7.

No task depends on old-attempt artifact visibility, undocumented cross-attempt job outputs, or historical-success fallback.