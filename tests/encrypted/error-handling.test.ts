import assert from "node:assert/strict";
import test from "node:test";
import { classifyRemoteRepo } from "../../src/lib/encrypted/remote-state";
import { ForeignRemoteError, userMessageForSyncError, WrongPassphraseError } from "../../src/lib/encrypted/sync-errors";
import { EncryptedManifestStore } from "../../src/lib/encrypted/manifest-store";
import { GitHubClient } from "../../src/lib/github-api";

class FakeGitHub {
  blobs: Map<string, string>;

  constructor(entries: Record<string, string> = {}) {
    this.blobs = new Map(Object.entries(entries));
  }

  async getTree() {
    return {
      sha: "tree",
      url: "",
      truncated: false,
      tree: [...this.blobs.keys()].map(path => ({ path, mode: "100644", type: "blob" as const, sha: `sha-${path}`, url: "" })),
    };
  }

  async getFile(path: string) {
    const content = this.blobs.get(path);
    if (content === undefined) return null;
    return { content: Buffer.from(content, "utf8").toString("base64"), sha: `sha-${path}`, path, size: content.length };
  }

  async putFile(path: string, content: string) {
    this.blobs.set(path, content);
    return `sha-${path}-${content.length}`;
  }
}

test("classifyRemoteRepo detects empty, encrypted, foreign, and corrupt states", async () => {
  assert.equal((await classifyRemoteRepo(new FakeGitHub() as unknown as GitHubClient)).kind, "empty");
  assert.equal((await classifyRemoteRepo(new FakeGitHub({ ".obsidian-github-sync-encrypted/config.json": "{}" }) as unknown as GitHubClient)).kind, "encrypted-plugin");
  assert.equal((await classifyRemoteRepo(new FakeGitHub({ "Notes/a.md": "plain" }) as unknown as GitHubClient)).kind, "foreign-nonempty");
  assert.equal((await classifyRemoteRepo(new FakeGitHub({ ".obsidian-github-sync-encrypted/orphan": "x" }) as unknown as GitHubClient)).kind, "corrupt-plugin");
});

test("manifest store blocks foreign non-empty repos unless explicitly allowed", async () => {
  const foreign = new FakeGitHub({ "Notes/a.md": "plain" }) as unknown as GitHubClient;
  await assert.rejects(() => new EncryptedManifestStore(foreign, "pw").loadOrCreate(), ForeignRemoteError);

  const allowed = new FakeGitHub({ "Notes/a.md": "plain" }) as unknown as GitHubClient;
  const result = await new EncryptedManifestStore(allowed, "pw", true).loadOrCreate();
  assert.equal(result.manifest.formatVersion, 1);
});

test("wrong passphrase and user-facing error messages are specific", () => {
  const wrong = new WrongPassphraseError();
  assert.match(wrong.message, /passphrase is wrong/u);
  assert.equal(userMessageForSyncError("forcePull", wrong, "Notes/a.md"), `Encrypted forcePull failed for Notes/a.md: ${wrong.message}`);
});
