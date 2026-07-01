import { GitHubClient, readGitHubFileBytes } from "../github-api";
import { commitGitTreeChanges, GitAtomicRefConflictError } from "../v3/git-atomic-writer";
import { bytesToUtf8, randomBytes, toBase64Url, utf8ToBytes } from "./bytes";
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

export interface EncryptedSnapshotExtraFile {
  path: string;
  bytes: Uint8Array;
}

function isCasFailure(error: unknown): boolean {
  const maybe = error as { status?: number; message?: string };
  return maybe?.status === 409 || maybe?.status === 412 || /stale|conflict|409|sha/i.test(maybe?.message ?? "");
}


interface RecentSnapshotWrite {
  commitSha: string;
  files: Map<string, { bytes: Uint8Array; sha: string }>;
}

const recentSnapshotWrites = new WeakMap<object, RecentSnapshotWrite>();

async function readRecentSnapshotWrite(github: object, path: string): Promise<{ bytes: Uint8Array; sha: string } | null> {
  const recent = recentSnapshotWrites.get(github);
  if (!recent) return null;
  const getGitRef = (github as { getGitRef?: () => Promise<{ sha: string }> }).getGitRef;
  if (typeof getGitRef === "function") {
    const ref = await getGitRef.call(github);
    if (ref.sha !== recent.commitSha) {
      recentSnapshotWrites.delete(github);
      return null;
    }
  }
  return recent.files.get(path) ?? null;
}

function rememberRecentSnapshotWrite(github: object, commitSha: string, files: Array<{ path: string; bytes: Uint8Array; sha: string }>): void {
  recentSnapshotWrites.set(github, { commitSha, files: new Map(files.map(file => [file.path, { bytes: file.bytes, sha: file.sha }])) });
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
    const cached = await readRecentSnapshotWrite(this.github, V2_HEAD_PATH);
    if (cached) return { head: await decryptSnapshotJson<EncryptedSnapshotHead>(this.key, bytesToUtf8(cached.bytes)), sha: cached.sha };
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


  async writeSnapshotAndHeadAtomic(input: EncryptedSnapshotManifest, head: EncryptedSnapshotHead, expectedHeadSha?: string, extraFiles: EncryptedSnapshotExtraFile[] = []): Promise<StoredEncryptedSnapshot & { headSha: string; headCommitSha?: string; fileShas?: Record<string, string> }> {
    const snapshot = ensureSnapshotId(input);
    const path = snapshotPath(snapshot.snapshotId);
    const encryptedSnapshot = await encryptJson(this.key, snapshot);
    const encryptedHead = await encryptJson(this.key, head);
    const github = this.github as SnapshotGitHubClient & {
      getGitRef?: unknown;
      getTree?: unknown;
      createGitBlob?: unknown;
      createGitTree?: unknown;
      createGitCommit?: unknown;
      updateGitRef?: unknown;
    };
    const hasGitApi = typeof github.getGitRef === "function"
      && typeof github.getTree === "function"
      && typeof github.createGitBlob === "function"
      && typeof github.createGitTree === "function"
      && typeof github.createGitCommit === "function"
      && typeof github.updateGitRef === "function";

    if (hasGitApi) {
      const snapshotBytes = utf8ToBytes(encryptedSnapshot);
      const headBytes = utf8ToBytes(encryptedHead);
      const maxAttempts = expectedHeadSha ? 1 : 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const result = await commitGitTreeChanges(github as any, {
            message: `sync: encrypted snapshot ${snapshot.snapshotId}`,
            files: [
              ...extraFiles,
              { path, bytes: snapshotBytes },
              { path: V2_HEAD_PATH, bytes: headBytes },
            ],
          });
          rememberRecentSnapshotWrite(this.github, result.commitSha, [
            ...extraFiles.map(file => ({ path: file.path, bytes: file.bytes, sha: result.fileShas[file.path] })),
            { path, bytes: snapshotBytes, sha: result.fileShas[path] },
            { path: V2_HEAD_PATH, bytes: headBytes, sha: result.fileShas[V2_HEAD_PATH] },
          ]);
          return { snapshot, path, sha: result.fileShas[path], headSha: result.fileShas[V2_HEAD_PATH], headCommitSha: result.commitSha, fileShas: result.fileShas };
        } catch (error) {
          const isConflict = error instanceof GitAtomicRefConflictError || isCasFailure(error);
          if (isConflict && attempt < maxAttempts) continue;
          if (isConflict) throw new SnapshotHeadCasError();
          throw error;
        }
      }
    }

    const written = await this.writeSnapshot(snapshot);
    const headSha = await this.updateHeadCas(head, expectedHeadSha);
    return { ...written, headSha };
  }

  async loadSnapshot(snapshotId: string): Promise<EncryptedSnapshotManifest | null> {
    const path = snapshotPath(snapshotId);
    const cached = await readRecentSnapshotWrite(this.github, path);
    if (cached) return decryptSnapshotJson<EncryptedSnapshotManifest>(this.key, bytesToUtf8(cached.bytes));
    const remote = await readGitHubFileBytes(this.github, path);
    if (!remote) return null;
    return decryptSnapshotJson<EncryptedSnapshotManifest>(this.key, bytesToUtf8(remote.bytes));
  }
}
