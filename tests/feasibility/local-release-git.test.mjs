import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runCommand } from "../../scripts/local-release-lib.mjs";
import {
  createAnnotatedTagObject,
  fetchAndInspectObservedQualificationTag,
  inspectTagObject,
  listRemoteStableTags,
  lookupRemoteRef,
  readCommittedBlob,
  readHeadSha,
  readRemoteMasterSha,
  requireCleanMaster,
} from "../../scripts/local-release-git.mjs";

function git(cwd, args, options = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout ?? "").trim();
}

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), "local-release-git-"));
  const remote = join(root, "origin.git");
  const work = join(root, "work");
  git(root, ["init", "--bare", "-q", remote]);
  git(root, ["init", "-q", "-b", "master", work]);
  git(work, ["config", "user.name", "Release Test"]);
  git(work, ["config", "user.email", "release-test@example.com"]);
  await writeFile(join(work, "file.txt"), Buffer.from([0x61, 0x00, 0x62, 0x0a]));
  git(work, ["add", "file.txt"]);
  git(work, ["commit", "-q", "-m", "initial"]);
  git(work, ["remote", "add", "origin", remote]);
  git(work, ["push", "-q", "-u", "origin", "master"]);
  return { root, remote, work, sha: git(work, ["rev-parse", "HEAD"]) };
}

function tagMessage(label) {
  return `${JSON.stringify({ label }, null, 2)}\n`;
}

test("clean/master and remote master helpers use exact commit SHA", async () => {
  const { work, sha } = await makeRepo();
  assert.equal(requireCleanMaster({ cwd: work }), sha);
  assert.equal(readHeadSha({ cwd: work }), sha);
  assert.equal(readRemoteMasterSha({ cwd: work }), sha);
  await writeFile(join(work, "dirty.txt"), "x");
  assert.throws(() => requireCleanMaster({ cwd: work }), /clean/i);
});

test("annotated tag object targets commit directly and raw object SHA can be pushed", async () => {
  const { work, sha } = await makeRepo();
  const name = `qualification/local/v1/1.0.8/${sha}`;
  const objectSha = createAnnotatedTagObject({ cwd: work, targetSha: sha, tagName: name, message: tagMessage("one") });
  const inspected = inspectTagObject({ cwd: work, objectSha });
  assert.equal(inspected.targetType, "commit");
  assert.equal(inspected.targetSha, sha);
  assert.equal(inspected.tagName, name);
  git(work, ["push", "-q", "origin", `${objectSha}:refs/tags/${name}`]);
  assert.deepEqual(lookupRemoteRef({ cwd: work, ref: `refs/tags/${name}` }), { kind: "present", objectSha });
});

test("tag-to-tag target remains detectable and is not mistaken for a direct commit", async () => {
  const { work, sha } = await makeRepo();
  const first = createAnnotatedTagObject({ cwd: work, targetSha: sha, tagName: "first", message: tagMessage("first") });
  const ident = git(work, ["var", "GIT_COMMITTER_IDENT"]);
  const nestedBody = `object ${first}\ntype tag\ntag second\ntagger ${ident}\n\n${tagMessage("second")}`;
  const second = git(work, ["mktag"], { input: nestedBody });
  const inspected = inspectTagObject({ cwd: work, objectSha: second });
  assert.equal(inspected.targetType, "tag");
  assert.equal(inspected.targetSha, first);
});

test("remote qualification inspection ignores a malicious same-named local tag", async () => {
  const { work, sha } = await makeRepo();
  const name = `qualification/local/v1/1.0.8/${sha}`;
  const remoteObject = createAnnotatedTagObject({ cwd: work, targetSha: sha, tagName: name, message: tagMessage("remote") });
  git(work, ["push", "-q", "origin", `${remoteObject}:refs/tags/${name}`]);
  git(work, ["tag", "-f", name, sha]);
  const result = fetchAndInspectObservedQualificationTag({ cwd: work, ref: `refs/tags/${name}`, randomId: () => "inspect123" });
  assert.equal(result.objectSha, remoteObject);
  assert.equal(result.tag.message, tagMessage("remote"));
  assert.equal(git(work, ["for-each-ref", "--format=%(refname)", "refs/local-qualification-inspect"]), "");
});

test("inspection rejects a remote object change between observation and fetch and cleans temp ref", async () => {
  const { work, remote, sha } = await makeRepo();
  const name = `qualification/local/v1/1.0.8/${sha}`;
  const first = createAnnotatedTagObject({ cwd: work, targetSha: sha, tagName: name, message: tagMessage("first") });
  const second = createAnnotatedTagObject({ cwd: work, targetSha: sha, tagName: name, message: tagMessage("second") });
  git(work, ["push", "-q", "origin", `${first}:refs/tags/${name}`]);
  git(work, ["push", "-q", "origin", `${second}:refs/tags/qualification-race-staging`]);
  let moved = false;
  const runner = (command, args, options) => {
    const result = runCommand(command, args, options);
    if (!moved && command === "git" && args[0] === "ls-remote" && result.status === 0) {
      moved = true;
      git(work, ["--git-dir", remote, "update-ref", `refs/tags/${name}`, second]);
    }
    return result;
  };
  assert.throws(() => fetchAndInspectObservedQualificationTag({ runner, cwd: work, ref: `refs/tags/${name}`, randomId: () => "inspect456" }), /changed during inspection/i);
  assert.equal(git(work, ["for-each-ref", "--format=%(refname)", "refs/local-qualification-inspect"]), "");
});

test("remote ref lookup distinguishes absent from command failure", async () => {
  const { work } = await makeRepo();
  assert.deepEqual(lookupRemoteRef({ cwd: work, ref: "refs/tags/missing" }), { kind: "absent" });
  assert.throws(() => lookupRemoteRef({ cwd: work, remote: "does-not-exist", ref: "refs/tags/missing" }), /lookup failed/i);
});

test("committed blob reader returns exact bytes rather than text-decoded content", async () => {
  const { work } = await makeRepo();
  const bytes = readCommittedBlob({ cwd: work, path: "file.txt" });
  assert.deepEqual(bytes, Buffer.from([0x61, 0x00, 0x62, 0x0a]));
});

test("remote stable tag listing ignores qualification namespace", async () => {
  const { work, sha } = await makeRepo();
  git(work, ["tag", "1.0.6", sha]);
  git(work, ["tag", "01.0.7", sha]);
  git(work, ["tag", "qualification/local/v1/1.0.8/x", sha]);
  git(work, ["push", "-q", "origin", "--tags"]);
  const names = listRemoteStableTags({ cwd: work }).map(item => item.name).sort();
  assert.deepEqual(names, ["01.0.7", "1.0.6"]);
});
