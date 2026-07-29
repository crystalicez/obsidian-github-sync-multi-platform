import assert from "node:assert/strict";
import test from "node:test";

import {
  createV4CandidateCommit,
  publishV4CandidateRef,
  publishV4TreeChanges,
  resolveV4PublicationBase,
  uploadV4TreeFiles,
} from "../../src/lib/v4/git-tree-writer";
import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";

class MemoryV4GitHub {
  ref: { ref: string; sha: string; type: string } | null = null;
  events: string[] = [];
  blobs: Uint8Array[] = [];
  trees: Array<{ entries: GitHubCreateTreeEntry[]; baseTree?: string }> = [];
  commits: Array<{ message: string; tree: string; parents: string[] }> = [];
  createdRefs: string[] = [];
  updatedRefs: Array<{ sha: string; expected?: string }> = [];
  initializedRef: { ref: string; sha: string; type: string } | null = null;

  async getGitRefOrNull() { return this.ref; }
  async ensureGitRepositoryInitialized() { this.ref = this.initializedRef; return this.ref; }
  async getGitCommit(sha: string) { return { sha, treeSha: "base-tree", parentShas: [] }; }
  async createGitBlob(bytes: Uint8Array) {
    this.events.push(`blob:${new TextDecoder().decode(bytes)}`);
    this.blobs.push(new Uint8Array(bytes));
    return `blob-${this.blobs.length}`;
  }
  async createGitTree(entries: GitHubCreateTreeEntry[], baseTree?: string) {
    this.events.push("tree");
    this.trees.push({ entries, baseTree });
    return `tree-${this.trees.length}`;
  }
  async createGitCommit(message: string, tree: string, parents: string[]) { this.commits.push({ message, tree, parents }); return `commit-${this.commits.length}`; }
  async createGitRef(sha: string) { this.createdRefs.push(sha); }
  async updateGitRef(sha: string, expected?: string) { this.updatedRefs.push({ sha, expected }); }
}

const bytes = (value: string) => new TextEncoder().encode(value);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

test("V4 tree writer initializes an empty branch with a root commit", async () => {
  const github = new MemoryV4GitHub();
  const result = await publishV4TreeChanges(github, {
    message: "obsidian-sync-v4:journal-1",
    files: [{ path: "Notes/a.md", bytes: new TextEncoder().encode("a") }],
  });

  assert.equal(result.commitSha, "commit-1");
  assert.equal(github.trees[0].baseTree, undefined);
  assert.deepEqual(github.commits[0].parents, []);
  assert.deepEqual(github.createdRefs, ["commit-1"]);
  assert.deepEqual(github.updatedRefs, []);
});

test("V4 tree writer updates an existing branch with CAS", async () => {
  const github = new MemoryV4GitHub();
  github.ref = { ref: "refs/heads/main", sha: "commit-old", type: "commit" };
  const result = await publishV4TreeChanges(github, {
    message: "obsidian-sync-v4:journal-2",
    files: [{ path: "Notes/a.md", bytes: new TextEncoder().encode("b") }],
    deletions: ["Notes/old.md"],
  });

  assert.equal(result.previousHeadSha, "commit-old");
  assert.equal(github.trees[0].baseTree, "base-tree");
  assert.deepEqual(github.commits[0].parents, ["commit-old"]);
  assert.deepEqual(github.updatedRefs, [{ sha: "commit-1", expected: "commit-old" }]);
  assert.deepEqual(github.trees[0].entries.at(-1), { path: "Notes/old.md", mode: "100644", type: "blob", sha: null });
});

test("V4 tree writer builds on the bootstrap commit for a truly empty repository", async () => {
  const github = new MemoryV4GitHub();
  github.initializedRef = { ref: "refs/heads/main", sha: "bootstrap", type: "commit" };

  await publishV4TreeChanges(github, {
    message: "obsidian-sync-v4:journal-bootstrap",
    files: [{ path: "Notes/a.md", bytes: new TextEncoder().encode("a") }],
    expectedHeadSha: null,
  });

  assert.equal(github.trees[0].baseTree, "base-tree");
  assert.deepEqual(github.commits[0].parents, ["bootstrap"]);
  assert.deepEqual(github.updatedRefs, [{ sha: "commit-1", expected: "bootstrap" }]);
  assert.deepEqual(github.createdRefs, []);
});

test("V4 tree writer reports logical uploads across files, parts, and shared packs", async () => {
  const github = new MemoryV4GitHub();
  const files = [
    { path: "one.enc", bytes: bytes("1"), progressItems: [{ fileId: "one", path: "A.md" }] },
    { path: "p1.enc", bytes: bytes("2"), progressItems: [{ fileId: "large", path: "Large.bin" }] },
    { path: "p2.enc", bytes: bytes("3"), progressItems: [{ fileId: "large", path: "Large.bin" }] },
    {
      path: "pack.enc",
      bytes: bytes("4"),
      progressItems: [
        { fileId: "packed-a", path: "P/A.md" },
        { fileId: "packed-b", path: "P/B.md" },
      ],
    },
    { path: ".obsidian-github-sync-v4/head.enc", bytes: bytes("metadata") },
  ];

  await publishV4TreeChanges(github, {
    message: "obsidian-sync-v4:logical-progress",
    files,
    onLogicalFileUploadStarted: item => github.events.push(`started:${item.fileId}:${item.path}`),
    onLogicalFileUploaded: item => github.events.push(`uploaded:${item.fileId}:${item.path}`),
    onUploadsComplete: () => github.events.push("uploads-complete"),
  });

  const started = github.events.filter(event => event.startsWith("started:"));
  assert.deepEqual(started, [
    "started:one:A.md",
    "started:large:Large.bin",
    "started:packed-a:P/A.md",
    "started:packed-b:P/B.md",
  ]);
  const uploaded = github.events.filter(event => event.startsWith("uploaded:"));
  assert.deepEqual(uploaded, [
    "uploaded:one:A.md",
    "uploaded:large:Large.bin",
    "uploaded:packed-a:P/A.md",
    "uploaded:packed-b:P/B.md",
  ]);
  assert.ok(github.events.indexOf("uploaded:large:Large.bin") > github.events.indexOf("blob:2"));
  assert.ok(github.events.indexOf("uploaded:large:Large.bin") > github.events.indexOf("blob:3"));
  assert.equal(github.events.filter(event => event === "uploads-complete").length, 1);
  assert.ok(github.events.indexOf("uploads-complete") > github.events.indexOf("uploaded:packed-b:P/B.md"));
  assert.ok(github.events.indexOf("uploads-complete") < github.events.indexOf("tree"));
  assert.equal(github.events.some(event => event.includes("metadata") && !event.startsWith("blob:")), false);
});

test("V4 tree writer ignores progress callback errors and completes Git writes", async () => {
  const github = new MemoryV4GitHub();
  const callbackEvents: string[] = [];

  const result = await publishV4TreeChanges(github, {
    message: "obsidian-sync-v4:callback-errors",
    files: [{ path: "one.enc", bytes: bytes("1"), progressItems: [{ fileId: "one", path: "A.md" }] }],
    onLogicalFileUploadStarted: () => { callbackEvents.push("started"); throw new Error("started failed"); },
    onLogicalFileUploaded: () => { callbackEvents.push("uploaded"); throw new Error("uploaded failed"); },
    onUploadsComplete: () => { callbackEvents.push("complete"); throw new Error("complete failed"); },
  });

  assert.deepEqual(callbackEvents, ["started", "uploaded", "complete"]);
  assert.equal(result.commitSha, "commit-1");
  assert.deepEqual(github.createdRefs, ["commit-1"]);
});

test("V4 tree writer settles already-started uploads before rejecting the first failure", async () => {
  const github = new MemoryV4GitHub();
  const delayed = [deferred<string>(), deferred<string>(), deferred<string>()];
  const events: string[] = [];
  const firstFailure = new Error("first upload failed");
  let upload = 0;
  github.createGitBlob = async data => {
    const current = upload++;
    events.push(`blob-started:${current}`);
    if (current === 0) throw firstFailure;
    const sha = await delayed[current - 1].promise;
    events.push(`blob-settled:${current}`);
    github.blobs.push(new Uint8Array(data));
    return sha;
  };

  const write = publishV4TreeChanges(github, {
    message: "obsidian-sync-v4:stable-failure-boundary",
    files: ["A", "B", "C", "D"].map(value => ({
      path: `${value}.enc`,
      bytes: bytes(value),
      progressItems: [{ fileId: value, path: `${value}.md` }],
    })),
    onLogicalFileUploaded: item => events.push(`uploaded:${item.fileId}`),
    onUploadsComplete: () => events.push("uploads-complete"),
  });
  const observed = write.then(
    () => { throw new Error("writer unexpectedly succeeded"); },
    error => { events.push("rejected"); return error as Error; },
  );

  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(upload, 4);
  delayed.forEach((gate, index) => gate.resolve(`blob-${index + 2}`));
  const error = await observed;

  assert.equal(error, firstFailure);
  assert.match(error.message, /first upload failed/iu);
  const rejectionIndex = events.indexOf("rejected");
  assert.notEqual(rejectionIndex, -1);
  assert.equal(events.slice(rejectionIndex + 1).some(event => event.startsWith("uploaded:")), false, events.join(", "));
  assert.equal(events.slice(0, rejectionIndex).filter(event => event.startsWith("uploaded:")).length, 3);
  assert.equal(events.includes("uploads-complete"), false);
  assert.equal(github.trees.length, 0);
  assert.equal(github.commits.length, 0);
  assert.deepEqual(github.createdRefs, []);
  assert.deepEqual(github.updatedRefs, []);
});


test("V4 tree writer creates an exact candidate before mutating the branch ref", async () => {
  const github = new MemoryV4GitHub();
  github.ref = { ref: "refs/heads/main", sha: "commit-old", type: "commit" };

  const base = await resolveV4PublicationBase(github, "commit-old");
  const uploaded = await uploadV4TreeFiles(github, { files: [{ path: "A.md", bytes: bytes("A") }] });
  const candidate = await createV4CandidateCommit(github, {
    base,
    message: "obsidian-sync-v4:journal-candidate",
    entries: uploaded.entries,
    deletions: ["old.md"],
  });

  assert.equal(candidate.commitSha, "commit-1");
  assert.equal(candidate.previousHeadSha, "commit-old");
  assert.deepEqual(github.updatedRefs, []);
  assert.deepEqual(github.createdRefs, []);

  await publishV4CandidateRef(github, candidate);
  assert.deepEqual(github.updatedRefs, [{ sha: "commit-1", expected: "commit-old" }]);
});

test("V4 publication base resolves bootstrap before creating a normal candidate", async () => {
  const github = new MemoryV4GitHub();
  github.initializedRef = { ref: "refs/heads/main", sha: "bootstrap", type: "commit" };

  const base = await resolveV4PublicationBase(github, null);

  assert.equal(base.ref?.sha, "bootstrap");
  assert.equal(base.baseTreeSha, "base-tree");
  assert.deepEqual(github.createdRefs, []);
  assert.deepEqual(github.updatedRefs, []);
});


test("V4 publication base rejects a stale expected head before uploads or bootstrap", async () => {
  const github = new MemoryV4GitHub();
  github.ref = { ref: "refs/heads/main", sha: "commit-current", type: "commit" };

  await assert.rejects(
    () => resolveV4PublicationBase(github, "commit-stale"),
    /branch head changed/iu,
  );

  assert.equal(github.blobs.length, 0);
  assert.equal(github.trees.length, 0);
  assert.equal(github.commits.length, 0);
  assert.deepEqual(github.createdRefs, []);
  assert.deepEqual(github.updatedRefs, []);
});


test("V4 tree writer wraps each Git blob creation in the supplied transport reservation", async () => {
  const github = new MemoryV4GitHub();
  const events: string[] = [];
  await publishV4TreeChanges(github, {
    message: "obsidian-sync-v4:transport-budget",
    files: [
      { path: "A.enc", bytes: bytes("A") },
      { path: "B.enc", bytes: bytes("BB") },
    ],
    withBlobTransport: async (payload, task) => {
      events.push(`reserve:${payload.byteLength}`);
      const sha = await task();
      events.push(`release:${payload.byteLength}`);
      return sha;
    },
  });
  assert.equal(events.filter(event => event.startsWith("reserve:")).length, 2);
  assert.equal(events.filter(event => event.startsWith("release:")).length, 2);
});

test("V4 candidate ref publication re-reads the branch head immediately before mutation", async () => {
  const github = new MemoryV4GitHub();
  github.ref = { ref: "refs/heads/main", sha: "commit-old", type: "commit" };
  const candidate = await createV4CandidateCommit(github, {
    base: { ref: github.ref, previousHeadSha: "commit-old", baseTreeSha: "base-tree" },
    message: "obsidian-sync-v4:late-cas",
    entries: [],
  });
  github.ref = { ref: "refs/heads/main", sha: "commit-raced", type: "commit" };

  await assert.rejects(publishV4CandidateRef(github, candidate), /branch head changed/iu);
  assert.deepEqual(github.updatedRefs, []);
  assert.deepEqual(github.createdRefs, []);
  assert.equal(github.commits.length, 1);
});
