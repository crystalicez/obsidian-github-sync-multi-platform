import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDraftArgs,
  createStableRef,
  publishDraftArgs,
  readReleaseState,
  readStableRef,
  requireGithubPublicationAuth,
  verifyReleaseAssets,
} from "../../scripts/local-release-github.mjs";

const repo = "crystalicez/obsidian-github-sync-multi-platform";
const sha = "a".repeat(40);

function sequenceRunner(steps) {
  const calls = [];
  const runner = (command, args, options = {}) => {
    calls.push({ command, args, options });
    const step = steps.shift();
    assert.ok(step, `unexpected call: ${command} ${args.join(" ")}`);
    if (typeof step === "function") return step({ command, args, options });
    return { status: step.status ?? 0, stdout: step.stdout ?? "", stderr: step.stderr ?? "" };
  };
  return { runner, calls };
}

test("publication auth pins github.com and proves push permission", () => {
  const { runner, calls } = sequenceRunner([
    { status: 0 },
    { status: 0, stdout: JSON.stringify({ permissions: { push: true } }) },
  ]);
  requireGithubPublicationAuth({ runner, repo, env: { GH_HOST: "evil.example" } });
  assert.deepEqual(calls[0].args, ["auth", "status", "--hostname", "github.com"]);
  assert.deepEqual(calls[1].args, ["api", "--hostname", "github.com", `repos/${repo}`]);
  assert.equal(calls[0].options.env.GH_HOST, "github.com");
  assert.equal(calls[1].options.env.GH_HOST, "github.com");
});

test("publication auth fails when write permission cannot be proven", () => {
  const { runner } = sequenceRunner([
    { status: 0 },
    { status: 0, stdout: JSON.stringify({ permissions: { push: false } }) },
  ]);
  assert.throws(() => requireGithubPublicationAuth({ runner, repo }), /write permission/i);
});

test("stable ref creation is create-only and post-verifies exact SHA", () => {
  const { runner, calls } = sequenceRunner([
    { status: 0, stdout: JSON.stringify({ ref: "refs/tags/1.0.8", object: { sha } }) },
    { status: 0, stdout: JSON.stringify([{ ref: "refs/tags/1.0.8", object: { sha, type: "commit" } }]) },
  ]);
  assert.deepEqual(createStableRef({ runner, repo, version: "1.0.8", sha }), { kind: "created" });
  assert.deepEqual(calls[0].args.slice(0, 7), ["api", "--hostname", "github.com", "--method", "POST", `repos/${repo}/git/refs`, "-f"]);
  assert.ok(calls[0].args.includes("ref=refs/tags/1.0.8"));
  assert.ok(calls[0].args.includes(`sha=${sha}`));
});

test("nonzero stable ref create never reconciles same-SHA state as ownership", () => {
  const { runner } = sequenceRunner([
    { status: 1, stderr: "HTTP 422" },
    { status: 0, stdout: JSON.stringify([{ ref: "refs/tags/1.0.8", object: { sha, type: "commit" } }]) },
  ]);
  assert.throws(() => createStableRef({ runner, repo, version: "1.0.8", sha }), /partial|concurrent/i);
});

test("stable ref read distinguishes successful absence and rejects malformed shape", () => {
  const absent = sequenceRunner([{ status: 0, stdout: "[]" }]);
  assert.deepEqual(readStableRef({ runner: absent.runner, repo, version: "1.0.8" }), { kind: "absent" });
  const malformed = sequenceRunner([{ status: 0, stdout: "{}" }]);
  assert.throws(() => readStableRef({ runner: malformed.runner, repo, version: "1.0.8" }), /malformed/i);
});

test("complete release listing covers drafts and requires unique exact tag", () => {
  const draft = { tag_name: "1.0.8", draft: true, prerelease: false, assets: [] };
  const present = sequenceRunner([{ status: 0, stdout: JSON.stringify([[draft]]) }]);
  assert.deepEqual(readReleaseState({ runner: present.runner, repo, version: "1.0.8" }), { kind: "present", release: draft });
  const absent = sequenceRunner([{ status: 0, stdout: JSON.stringify([[], [{ tag_name: "1.0.7" }]]) }]);
  assert.deepEqual(readReleaseState({ runner: absent.runner, repo, version: "1.0.8" }), { kind: "absent" });
  const duplicate = sequenceRunner([{ status: 0, stdout: JSON.stringify([[draft], [draft]]) }]);
  assert.throws(() => readReleaseState({ runner: duplicate.runner, repo, version: "1.0.8" }), /duplicate/i);
});

test("draft and publish argv are explicit and contain no clobber/delete path", () => {
  const assets = ["/tmp/main.js", "/tmp/manifest.json", "/tmp/styles.css", "/tmp/plugin.zip"];
  const args = createDraftArgs({ repo, version: "1.0.8", previousStableTag: "1.0.7", stagedAssetPaths: assets });
  assert.deepEqual(args, [
    "release", "create", "1.0.8", "--repo", repo, "--verify-tag", "--draft", "--title", "1.0.8", "--generate-notes", "--notes-start-tag", "1.0.7", ...assets,
  ]);
  assert.equal(args.includes("--clobber"), false);
  assert.deepEqual(publishDraftArgs({ repo, version: "1.0.8" }), ["release", "edit", "1.0.8", "--repo", repo, "--draft=false"]);
});

function localArtifacts() {
  return ["main.js", "manifest.json", "styles.css", "obsidian-github-sync-multi-platform-v1.0.8.zip"].map((name, index) => {
    const bytes = Buffer.from(`asset-${index}-${name}`);
    return { name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
  });
}

test("asset verification requires exact set, uploaded state, size, and sha256 digest", async () => {
  const local = localArtifacts();
  const release = {
    tag_name: "1.0.8",
    assets: local.map(item => ({ name: item.name, state: "uploaded", size: item.size, digest: `sha256:${item.sha256}` })),
  };
  await verifyReleaseAssets({ runner: () => { throw new Error("no download expected"); }, repo, version: "1.0.8", release, localArtifacts: local, tempRoot: "/tmp/nope" });
  await assert.rejects(() => verifyReleaseAssets({ repo, version: "1.0.8", release: { ...release, assets: [...release.assets, { ...release.assets[0], name: "extra" }] }, localArtifacts: local, tempRoot: "/tmp/nope" }), /asset set/i);
  await assert.rejects(() => verifyReleaseAssets({ repo, version: "1.0.8", release: { ...release, assets: release.assets.map((a, i) => i ? a : { ...a, state: "new" }) }, localArtifacts: local, tempRoot: "/tmp/nope" }), /not uploaded/i);
  await assert.rejects(() => verifyReleaseAssets({ repo, version: "1.0.8", release: { ...release, assets: release.assets.map((a, i) => i ? a : { ...a, digest: "md5:deadbeef" }) }, localArtifacts: local, tempRoot: "/tmp/nope" }), /not SHA-256/i);
});

test("missing API digest downloads one exact asset to a fresh file and hashes it", async () => {
  const local = localArtifacts();
  const target = local[0];
  const release = {
    tag_name: "1.0.8",
    assets: local.map((item, index) => ({ name: item.name, state: "uploaded", size: item.size, digest: index === 0 ? null : `sha256:${item.sha256}` })),
  };
  const root = await mkdtemp(join(tmpdir(), "asset-fallback-"));
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, "gh");
    const output = args[args.indexOf("--output") + 1];
    writeFileSync(output, target.bytes);
    return { status: 0, stdout: "", stderr: "" };
  };
  await verifyReleaseAssets({ runner, repo, version: "1.0.8", release, localArtifacts: local, tempRoot: root });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 5), ["release", "download", "1.0.8", "--repo", repo]);
  assert.ok(calls[0].args.includes("--pattern"));
  assert.equal(calls[0].args.includes("--clobber"), false);
  assert.equal(calls[0].args.includes("--skip-existing"), false);
  assert.equal(calls[0].options.env.GH_HOST, "github.com");
});
