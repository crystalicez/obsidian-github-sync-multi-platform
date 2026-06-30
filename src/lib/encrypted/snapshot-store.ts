import { GitHubClient, readGitHubFileBytes } from "../github-api";
import { bytesToUtf8, randomBytes, toBase64Url } from "./bytes";
import { decryptJson, encryptJson } from "./crypto";
import { WrongPassphraseError } from "./sync-errors";
import type { EncryptedSnapshotHead, EncryptedSnapshotManifest, StoredEncryptedSnapshot, StoredEncryptedSnapshotHead } from "./snapshot-types";

export const V2_ROOT = ".obsidian-github-sync-v2";
export const V2_HEAD_PATH = `${V2_ROOT}/head.enc`;
export const V2_SNAPSHOTS_ROOT = `${V2_ROOT}/snapshots`;

export class SnapshotHeadCasError extends Error {
  constructor(message = "Encrypted snapshot head changed on remote; reload and merge before retrying.") {
    super(message);
    this.name = "SnapshotHeadCasError";
  }
}

type SnapshotGitHubClient = GitHubClient & {
  putFileCas?: (path: string, content: string | ArrayBuffer, expectedSha?: string) => Promise<string>;
};

function isCasFailure(error: unknown): boolean {
  const maybe = error as { status?: number; message?: string };
  return maybe?.status === 409 || maybe?.status === 412 || /stale|conflict|409|sha/i.test(maybe?.message ?? "");
}

function snapshotPath(snapshotId: string): string {
  return `${V2_SNAPSHOTS_ROOT}/${snapshotId}.enc`;
}

async function decryptSnapshotJson<T>(key: CryptoKey, encrypted: string): Promise<T> {
  try {
    return await decryptJson<T>(key, encrypted);
  } catch (error) {
    throw new WrongPassphraseError();
  }
}
function ensureSnapshotId(snapshot: EncryptedSnapshotManifest): EncryptedSnapshotManifest {
  if (snapshot.snapshotId) return snapshot;
  return { ...snapshot, snapshotId: toBase64Url(randomBytes(18)) };
}

export class EncryptedSnapshotStore {
  constructor(private readonly github: GitHubClient, private readonly key: CryptoKey) {}

  async loadHead(): Promise<StoredEncryptedSnapshotHead | null> {
    const remote = await readGitHubFileBytes(this.github, V2_HEAD_PATH);
    if (!remote) return null;
    return { head: await decryptSnapshotJson<EncryptedSnapshotHead>(this.key, bytesToUtf8(remote.bytes)), sha: remote.sha };
  }

  async updateHeadCas(head: EncryptedSnapshotHead, expectedSha?: string): Promise<string> {
    const encrypted = await encryptJson(this.key, head);
    try {
      const github = this.github as SnapshotGitHubClient;
      if (typeof github.putFileCas === "function") return await github.putFileCas(V2_HEAD_PATH, encrypted, expectedSha);
      return await github.putFile(V2_HEAD_PATH, encrypted, expectedSha);
    } catch (error) {
      if (isCasFailure(error)) throw new SnapshotHeadCasError();
      throw error;
    }
  }

  async writeSnapshot(input: EncryptedSnapshotManifest): Promise<StoredEncryptedSnapshot> {
    const snapshot = ensureSnapshotId(input);
    const path = snapshotPath(snapshot.snapshotId);
    const encrypted = await encryptJson(this.key, snapshot);
    const sha = await this.github.putFile(path, encrypted);
    return { snapshot, path, sha };
  }

  async loadSnapshot(snapshotId: string): Promise<EncryptedSnapshotManifest | null> {
    const remote = await readGitHubFileBytes(this.github, snapshotPath(snapshotId));
    if (!remote) return null;
    return decryptSnapshotJson<EncryptedSnapshotManifest>(this.key, bytesToUtf8(remote.bytes));
  }
}