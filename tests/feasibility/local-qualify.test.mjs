import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { qualifyLocal } from "../../scripts/local-qualify.mjs";
import { QUALIFICATION_GATES, qualificationRefName, qualificationTagName } from "../../scripts/local-release-lib.mjs";

const CANONICAL_HTTPS = "https://github.com/crystalicez/obsidian-github-sync-multi-platform.git";
const CANONICAL_SSH = "git@github.com:crystalicez/obsidian-github-sync-multi-platform.git";

function git(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: options.encoding === null ? null : "utf8",
    input: options.input,
    env: options.env,
  });
  assert.equal(result.status, 0, result.stderr?.toString() || result.stdout?.toString());
  return result;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qualify-local-"));
  const work = join(root, "work");
  const bare = join(root, "origin.git");
  git(root, ["init", "-q", "--bare", bare]);
  git(root, ["init", "-q", "-b", "master", work]);
  git(work, ["config", "user.name", "Test Maintainer"]);
  git(work, ["config", "user.email", "maintainer@example.test"]);
  await writeFile(join(work, "package.json"), JSON.stringify({ version: "1.0.8", packageManager: "pnpm@9.12.3+sha512.deadbeef" }, null, 2) + "\n");
  await writeFile(join(work, "manifest.json"), JSON.stringify({ id: "encrypted-github-sync-multi-platform", version: "1.0.8", minAppVersion: "1.11.4" }, null, 2) + "\n");
  await writeFile(join(work, "versions.json"), JSON.stringify({ "1.0.8": "1.11.4" }, null, 2) + "\n");
  await writeFile(join(work, ".node-version"), "v22.11.0\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-qm", "fixture"]);
  const sha = git(work, ["rev-parse", "HEAD"]).stdout.trim();
  git(work, ["remote", "add", "origin", bare]);
  git(work, ["push", "-q", "origin", "master"]);
  return { root, work, bare, sha };
}

function response(status, body = {}) {
  return { status, async json() { return body; } };
}

function makeFetch({ cleanupStatus = 404 } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    if (!url.includes("/git/ref/heads/")) return response(200, { default_branch: "main" });
    if (cleanupStatus === "network") throw new Error("network");
    if (cleanupStatus === 403) return response(403, {});
    return response(cleanupStatus, {});
  };
  return { impl, calls };
}

function makeRunner({ bare, events = [], liveStatus = 0, ambiguousPush = false, masterSequence, pushUrlSequence } = {}) {
  let masterReads = 0;
  let pushUrlReads = 0;
  return (command, args, options = {}) => {
    if (command === "corepack") {
      if (args.join(" ") === "pnpm --version") return { status: 0, stdout: "9.12.3\n", stderr: "" };
      const script = args[1] === "install" ? "install-frozen"
        : args[1] === "build" ? "build"
        : args[1] === "validate:package" ? "package-validation"
        : args[1] === "test" ? "fast-tests"
        : args[1] === "test:repeat" ? "repeat-tests"
        : args[1] === "test:recovery" ? "recovery-tests"
        : args[1] === "test:resource" ? "resource-tests"
        : args[1] === "test:feasibility" ? "feasibility-tests"
        : args[1] === "test:github-e2e:compile" ? "github-e2e-compile"
        : args[1] === "test:github-e2e:quick" ? "github-e2e-live"
        : `unknown:${args.join(" ")}`;
      events.push({
        kind: "runner-gate",
        name: script,
        branch: options.env?.GITHUB_E2E_BRANCH,
        hasToken: options.env?.GITHUB_E2E_TOKEN !== undefined,
      });
      return { status: script === "github-e2e-live" ? liveStatus : 0, stdout: "", stderr: "" };
    }
    if (command !== "git") return { status: 1, stdout: "", stderr: `unexpected ${command}` };

    if (args[0] === "remote" && args[1] === "get-url") {
      const isPush = args.includes("--push");
      if (isPush) {
        const value = pushUrlSequence?.[Math.min(pushUrlReads++, pushUrlSequence.length - 1)] ?? CANONICAL_SSH;
        return { status: 0, stdout: `${value}\n`, stderr: "" };
      }
      return { status: 0, stdout: `${CANONICAL_HTTPS}\n`, stderr: "" };
    }

    const rewritten = args.map(value => value === "origin" ? bare : value);
    if (args[0] === "ls-remote" && args.at(-1) === "refs/heads/master" && masterSequence) {
      const sha = masterSequence[Math.min(masterReads++, masterSequence.length - 1)];
      return { status: 0, stdout: `${sha}\trefs/heads/master\n`, stderr: "" };
    }
    const result = spawnSync("git", rewritten, {
      cwd: options.cwd,
      encoding: options.encoding === null ? null : "utf8",
      input: options.input,
      env: options.env,
    });
    if (ambiguousPush && args[0] === "push" && args.some(value => String(value).includes("refs/tags/qualification/local/"))) {
      assert.equal(result.status, 0, result.stderr?.toString() || result.stdout?.toString());
      return { status: 1, stdout: "", stderr: "transport closed after write" };
    }
    return result;
  };
}

function baseOptions(f, extras = {}) {
  const progress = [];
  const runnerEvents = [];
  const fetcher = makeFetch(extras.fetch ?? {});
  const runner = makeRunner({ bare: f.bare, events: runnerEvents, ...extras.runner });
  let tick = 0;
  const times = [new Date("2026-08-28T00:00:00.000Z"), new Date("2026-08-28T00:00:05.000Z")];
  return {
    progress,
    runnerEvents,
    options: {
      cwd: f.work,
      runner,
      fetchImpl: fetcher.impl,
      now: () => times[Math.min(tick++, times.length - 1)],
      runId: "runid123",
      sleep: async () => {},
      env: {
        GITHUB_E2E_OWNER: "e2e-owner",
        GITHUB_E2E_REPO: "disposable-repo",
        GITHUB_E2E_BRANCH: "main",
        GITHUB_E2E_TOKEN: "secret-token",
      },
      runtimeNodeVersion: "v22.11.0",
      platform: "linux",
      arch: "x64",
      onProgress: event => progress.push(event),
    },
  };
}

async function createInvalidRemoteReceipt(f) {
  const ref = qualificationRefName("1.0.8", f.sha);
  const tag = qualificationTagName("1.0.8", f.sha);
  const bad = JSON.stringify({ nope: true }, null, 2) + "\n";
  const ident = git(f.work, ["var", "GIT_COMMITTER_IDENT"]).stdout.trim();
  const object = git(f.work, ["mktag"], { input: `object ${f.sha}\ntype commit\ntag ${tag}\ntagger ${ident}\n\n${bad}` }).stdout.trim();
  git(f.work, ["push", "-q", f.bare, `${object}:${ref}`]);
}

test("qualification executes exact v1 gate order, isolates token, and overrides manual branch", async () => {
  const f = await fixture();
  const { options, progress, runnerEvents } = baseOptions(f);
  const result = await qualifyLocal(options);
  assert.equal(result.alreadyQualified, false);
  assert.deepEqual(progress.filter(e => e.kind === "gate").map(e => e.name), QUALIFICATION_GATES);
  const gateRuns = runnerEvents.filter(e => e.kind === "runner-gate");
  const live = gateRuns.find(e => e.name === "github-e2e-live");
  assert.match(live.branch, /^obsidian-sync-e2e\/local-/u);
  assert.notEqual(live.branch, "main");
  assert.equal(live.hasToken, true);
  assert.equal(gateRuns.filter(e => e.name !== "github-e2e-live").some(e => e.hasToken), false);
  const remote = git(f.work, ["ls-remote", "--refs", f.bare, result.qualificationRef]).stdout.trim();
  assert.match(remote, new RegExp(`^${result.qualificationTagObjectSha}\\s`));
});

test("valid existing remote receipt short-circuits without E2E credentials or gates", async () => {
  const f = await fixture();
  const first = baseOptions(f);
  await qualifyLocal(first.options);
  const secondEvents = [];
  const secondRunner = makeRunner({ bare: f.bare, events: secondEvents });
  const result = await qualifyLocal({
    ...first.options,
    runner: secondRunner,
    env: {},
    fetchImpl: async () => { throw new Error("E2E preflight must not run"); },
    now: () => new Date("2026-08-28T01:00:00.000Z"),
  });
  assert.equal(result.alreadyQualified, true);
  assert.equal(secondEvents.length, 0);
});

test("invalid existing remote receipt fails closed", async () => {
  const f = await fixture();
  await createInvalidRemoteReceipt(f);
  const { options } = baseOptions(f);
  await assert.rejects(() => qualifyLocal(options), /receipt fields|receipt/i);
});

for (const [name, liveStatus, cleanupStatus, pattern] of [
  ["live failure with clean cleanup", 1, 404, /live gate failed; cleanup verified/i],
  ["cleanup failure after live success", 0, 403, /cleanup verification failed/i],
  ["live and cleanup failure", 1, 403, /live gate failed; cleanup also failed/i],
]) {
  test(name, async () => {
    const f = await fixture();
    const { options } = baseOptions(f, { runner: { liveStatus }, fetch: { cleanupStatus } });
    await assert.rejects(() => qualifyLocal(options), pattern);
    const ref = qualificationRefName("1.0.8", f.sha);
    assert.equal(git(f.work, ["ls-remote", "--refs", f.bare, ref]).stdout.trim(), "");
  });
}

test("remote master movement after gates prevents receipt creation", async () => {
  const f = await fixture();
  const moved = "b".repeat(40);
  const { options } = baseOptions(f, { runner: { masterSequence: [f.sha, moved] } });
  await assert.rejects(() => qualifyLocal(options), /remote master changed/i);
});

test("origin pushurl movement after gates prevents receipt creation", async () => {
  const f = await fixture();
  const { options } = baseOptions(f, { runner: { pushUrlSequence: [CANONICAL_SSH, "git@github.com:attacker/other.git"] } });
  await assert.rejects(() => qualifyLocal(options), /origin push repository/i);
});

test("ambiguous push reconciles only when remote contains this invocation tag object", async () => {
  const f = await fixture();
  const { options } = baseOptions(f, { runner: { ambiguousPush: true } });
  const result = await qualifyLocal(options);
  assert.equal(result.alreadyQualified, false);
  const remote = git(f.work, ["ls-remote", "--refs", f.bare, result.qualificationRef]).stdout.trim();
  assert.match(remote, new RegExp(`^${result.qualificationTagObjectSha}\\s`));
});
