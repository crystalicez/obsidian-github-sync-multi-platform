import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseLocal } from "../../scripts/local-release.mjs";

const SHA = "a".repeat(40);
const QUAL_OBJECT = "b".repeat(40);
const REPO = "crystalicez/obsidian-github-sync-multi-platform";

function qualificationState(objectSha = QUAL_OBJECT) {
  return {
    kind: "present",
    objectSha,
    tag: {
      targetType: "commit",
      targetSha: SHA,
      tagName: `qualification/local/v1/1.0.8/${SHA}`,
      message: `${JSON.stringify({
        schemaVersion: 1,
        kind: "obsidian-sync-local-qualification",
        repository: REPO,
        commitSha: SHA,
        version: "1.0.8",
        result: "success",
        qualifiedAt: "2026-08-28T00:00:00.000Z",
        durationMs: 1234,
        platform: "linux-x64",
        nodeVersion: "v22.11.0",
        pnpmVersion: "9.12.3",
        e2eSuite: "github-e2e-quick",
        gates: [
          "metadata-validation", "install-frozen", "build", "package-validation", "fast-tests",
          "repeat-tests", "recovery-tests", "resource-tests", "feasibility-tests",
          "github-e2e-compile", "github-e2e-live", "github-e2e-cleanup-verified",
        ],
      }, null, 2)}\n`,
    },
  };
}

async function artifactFixture() {
  const dir = await mkdtemp(join(tmpdir(), "release-local-artifacts-"));
  const names = ["main.js", "manifest.json", "styles.css", "obsidian-github-sync-multi-platform-v1.0.8.zip"];
  const assets = [];
  for (const [index, name] of names.entries()) {
    const path = join(dir, name);
    const bytes = Buffer.from(`asset-${index}-${name}`);
    await writeFile(path, bytes);
    assets.push({ name, path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return { stagingDir: dir, zipPath: assets[3].path, assets };
}

function draftRelease(assets, overrides = {}) {
  return {
    tag_name: "1.0.8",
    draft: true,
    prerelease: false,
    html_url: "https://github.com/crystalicez/obsidian-github-sync-multi-platform/releases/tag/1.0.8",
    assets: assets.map(item => ({ name: item.name, state: "uploaded", size: item.size, digest: `sha256:${item.sha256}` })),
    ...overrides,
  };
}

async function harness(overrides = {}) {
  const packaged = await artifactFixture();
  const events = [];
  const calls = [];
  let stableCreated = false;
  let release = null;
  let masterReads = 0;
  let qualReads = 0;
  const masterSequence = overrides.masterSequence ?? [SHA];
  const qualificationSequence = overrides.qualificationSequence ?? [qualificationState()];
  const metadata = {
    packageJson: { version: "1.0.8", packageManager: "pnpm@9.12.3" },
    manifest: { id: "plugin", version: "1.0.8", minAppVersion: "1.11.4" },
    versions: { "1.0.8": "1.11.4" },
    nodeVersion: "v22.11.0",
    pnpmVersion: "9.12.3",
  };
  const services = {
    requireCleanMaster() { calls.push("clean"); return SHA; },
    requireCanonicalOriginEndpoints() { calls.push("origin"); return { fetchRepository: REPO, pushRepository: REPO }; },
    readRemoteMasterSha() { calls.push("master"); return masterSequence[Math.min(masterReads++, masterSequence.length - 1)]; },
    async readReleaseMetadata() { return metadata; },
    validateReleaseMetadata(value, { requestedVersion } = {}) {
      if (requestedVersion && requestedVersion !== "1.0.8") throw new Error("requested version mismatch");
      return { version: "1.0.8", minAppVersion: "1.11.4", pluginId: "plugin", nodeVersion: "v22.11.0", pnpmVersion: "9.12.3" };
    },
    readPnpmVersion() { return "9.12.3"; },
    requireGithubPublicationAuth() { calls.push("auth"); },
    listRemoteStableTags() { return overrides.stableTags ?? [{ name: "1.0.7", objectSha: "c".repeat(40) }]; },
    readStableRef() { return stableCreated ? { kind: "present", ref: "refs/tags/1.0.8", sha: SHA } : { kind: "absent" }; },
    readReleaseState() { return release ? { kind: "present", release } : { kind: "absent" }; },
    fetchAndInspectObservedQualificationTag() {
      calls.push("qualification");
      return qualificationSequence[Math.min(qualReads++, qualificationSequence.length - 1)];
    },
    runPnpmGate(name) { calls.push(`gate:${name}`); return { status: 0, stdout: "", stderr: "" }; },
    async packagePlugin() { calls.push("package"); return packaged; },
    createStableRef() {
      calls.push("stable-create");
      if (overrides.createStableError) throw overrides.createStableError;
      stableCreated = true;
      return { kind: "created" };
    },
    createDraftArgs({ previousStableTag, stagedAssetPaths }) {
      calls.push(`notes:${previousStableTag ?? "none"}`);
      return ["release", "create", "1.0.8", ...stagedAssetPaths];
    },
    runGitHubCli({ args }) {
      calls.push(`gh:${args.slice(0, 3).join(":")}`);
      if (args[0] === "release" && args[1] === "create") {
        release = draftRelease(packaged.assets);
        return overrides.draftResult ?? { status: 0, stdout: release.html_url, stderr: "" };
      }
      if (args[0] === "release" && args[1] === "edit") {
        if (!overrides.keepDraftAfterPublish) release = { ...release, draft: false };
        return overrides.publishResult ?? { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected gh args ${args.join(" ")}`);
    },
    publishDraftArgs() { return ["release", "edit", "1.0.8", "--draft=false"]; },
    async verifyReleaseAssets({ release: remote }) {
      calls.push("verify-assets");
      assert.equal(remote.tag_name, "1.0.8");
    },
    ...overrides.services,
  };
  return { packaged, events, calls, services, getRelease: () => release };
}

const PHASES = [
  "preflight", "qualification-snapshot", "publication-gates", "package", "final-pre-mutation-check",
  "stable-ref-create", "post-ref-recheck", "draft-create", "draft-asset-verify", "final-publish-check",
  "publish", "post-verify",
];

test("public release is unreachable before all exact verification phases", async () => {
  const h = await harness();
  const result = await releaseLocal({
    cwd: "/repo", version: "1.0.8", services: h.services,
    runtimeNodeVersion: "v22.11.0", onProgress: event => h.events.push(event),
  });
  assert.deepEqual(h.events.filter(e => e.phase).map(e => e.phase), PHASES);
  assert.deepEqual(h.calls.filter(value => value.startsWith("gate:")), [
    "gate:install-frozen", "gate:build", "gate:package-validation", "gate:fast-tests", "gate:github-e2e-compile",
  ]);
  assert.ok(h.calls.includes("notes:1.0.7"));
  assert.equal(result.version, "1.0.8");
  assert.equal(result.sha, SHA);
  assert.equal(result.qualificationTagObjectSha, QUAL_OBJECT);
});

test("release strips GitHub E2E token from publication children while preserving GitHub auth env", async () => {
  const h = await harness();
  const seen = [];
  h.services.requireCleanMaster = ({ runner }) => {
    runner("env-probe", [], {});
    return SHA;
  };
  h.services.readPnpmVersion = ({ env }) => {
    seen.push(env);
    return "9.12.3";
  };
  h.services.requireGithubPublicationAuth = ({ env }) => {
    seen.push(env);
  };
  h.services.runPnpmGate = (name, { env }) => {
    seen.push(env);
    return { status: 0, stdout: "", stderr: "" };
  };
  const probeEnvs = [];
  const runner = (command, args, options = {}) => {
    if (command !== "env-probe") throw new Error(`unexpected runner command ${command} ${args.join(" ")}`);
    probeEnvs.push(options.env);
    return { status: 0, stdout: "", stderr: "" };
  };
  await releaseLocal({
    cwd: "/repo",
    version: "1.0.8",
    runner,
    services: h.services,
    runtimeNodeVersion: "v22.11.0",
    env: { PATH: "/bin", GH_TOKEN: "publication-token", GITHUB_E2E_TOKEN: "e2e-secret" },
  });
  for (const childEnv of [...seen, ...probeEnvs]) {
    assert.equal(childEnv.GITHUB_E2E_TOKEN, undefined);
    assert.equal(childEnv.GH_TOKEN, "publication-token");
    assert.equal(childEnv.PATH, "/bin");
  }
});

test("preflight rejects invalid syntax, non-monotonic versions, and existing publication state", async () => {
  const h1 = await harness();
  await assert.rejects(() => releaseLocal({ cwd: "/repo", version: "v1.0.8", services: h1.services, runtimeNodeVersion: "v22.11.0" }), /x\.y\.z/i);
  const h2 = await harness({ stableTags: [{ name: "1.0.8", objectSha: "c".repeat(40) }] });
  await assert.rejects(() => releaseLocal({ cwd: "/repo", version: "1.0.8", services: h2.services, runtimeNodeVersion: "v22.11.0" }), /greater than every remote stable/i);
  const h3 = await harness({ services: { readReleaseState() { return { kind: "present", release: { tag_name: "1.0.8", draft: true, prerelease: false, assets: [] } }; } } });
  await assert.rejects(() => releaseLocal({ cwd: "/repo", version: "1.0.8", services: h3.services, runtimeNodeVersion: "v22.11.0" }), /already exists/i);
});

test("master movement before stable ref creation blocks every stable mutation", async () => {
  const h = await harness({ masterSequence: [SHA, "d".repeat(40)] });
  await assert.rejects(() => releaseLocal({ cwd: "/repo", version: "1.0.8", services: h.services, runtimeNodeVersion: "v22.11.0" }), /remote master changed/i);
  assert.equal(h.calls.includes("stable-create"), false);
});

test("qualification object replacement after stable ref claim blocks draft creation", async () => {
  const h = await harness({ qualificationSequence: [qualificationState(), qualificationState(), qualificationState("e".repeat(40))] });
  await assert.rejects(() => releaseLocal({ cwd: "/repo", version: "1.0.8", services: h.services, runtimeNodeVersion: "v22.11.0" }), /qualification.*changed/i);
  assert.equal(h.calls.some(value => value.startsWith("gh:release:create")), false);
});

test("nonzero draft creation stops for inspection and never publishes", async () => {
  const h = await harness({ draftResult: { status: 1, stderr: "transport lost" } });
  await assert.rejects(() => releaseLocal({ cwd: "/repo", version: "1.0.8", services: h.services, runtimeNodeVersion: "v22.11.0" }), /draft creation failed/i);
  assert.equal(h.calls.some(value => value.startsWith("gh:release:edit")), false);
});

test("nonzero publish reconciles success only from exact final published state", async () => {
  const h = await harness({ publishResult: { status: 1, stderr: "connection reset" } });
  const result = await releaseLocal({ cwd: "/repo", version: "1.0.8", services: h.services, runtimeNodeVersion: "v22.11.0" });
  assert.equal(result.reconciledPublish, true);
  assert.equal(h.getRelease().draft, false);
});

test("nonzero publish with remaining draft fails closed", async () => {
  const h = await harness({ publishResult: { status: 1 }, keepDraftAfterPublish: true });
  await assert.rejects(() => releaseLocal({ cwd: "/repo", version: "1.0.8", services: h.services, runtimeNodeVersion: "v22.11.0" }), /post-publication|published/i);
});

test("local staged artifact mutation is detected before first remote stable mutation", async () => {
  const h = await harness();
  let masterRead = 0;
  h.services.readRemoteMasterSha = () => {
    masterRead += 1;
    if (masterRead === 2) writeFile(h.packaged.assets[0].path, "tampered");
    return SHA;
  };
  await assert.rejects(() => releaseLocal({ cwd: "/repo", version: "1.0.8", services: h.services, runtimeNodeVersion: "v22.11.0" }), /staged release asset changed/i);
  assert.equal(h.calls.includes("stable-create"), false);
});
