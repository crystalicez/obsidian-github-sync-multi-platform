const GIT_OBJECT_SHA = /^[0-9a-f]{40}$/iu;

type ImmutableGitNodeType = "blob" | "tree" | "commit";

interface ImmutableGitNode {
  path: string;
  type: ImmutableGitNodeType;
  mode: string;
  sha: string;
}

export interface ImmutableGitReadAdapter {
  getCommit(sha: string): Promise<{ treeSha: string }>;
  getTree(treeSha: string): Promise<unknown>;
  getBlob(blobSha: string): Promise<Uint8Array>;
}

function immutablePathSegments(path: string): string[] {
  const segments = path.split("/");
  if (segments.length === 0 || segments.some(segment => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Invalid immutable Git path segment in ${JSON.stringify(path)}.`);
  }
  return segments;
}

function malformedTree(path: string, detail: string): Error {
  return new Error(`GitHub immutable tree is malformed while resolving ${path}: ${detail}.`);
}

function incompleteTree(path: string, segment: string): Error {
  return new Error(`GitHub immutable tree evidence is incomplete while resolving segment ${JSON.stringify(segment)} for ${path}.`);
}

function unsupportedNode(path: string, node: { type: unknown; mode: unknown }): Error {
  return new Error(`Unsupported Git object mode/type at immutable managed path ${path}: type=${String(node.type)} mode=${String(node.mode)}.`);
}

function validateNode(raw: Record<string, unknown>, path: string): ImmutableGitNode {
  if (typeof raw.path !== "string") throw malformedTree(path, "tree entry path is not a string");
  if (raw.type !== "blob" && raw.type !== "tree" && raw.type !== "commit") {
    throw malformedTree(path, `tree entry ${JSON.stringify(raw.path)} has unsupported type`);
  }
  if (typeof raw.mode !== "string") throw malformedTree(path, `tree entry ${JSON.stringify(raw.path)} has invalid mode`);
  if (typeof raw.sha !== "string" || !GIT_OBJECT_SHA.test(raw.sha)) {
    throw malformedTree(path, `tree entry ${JSON.stringify(raw.path)} has invalid SHA`);
  }

  const node: ImmutableGitNode = { path: raw.path, type: raw.type, mode: raw.mode, sha: raw.sha };
  const supported = (node.type === "tree" && node.mode === "040000")
    || (node.type === "commit" && node.mode === "160000")
    || (node.type === "blob" && (node.mode === "100644" || node.mode === "100755" || node.mode === "120000"));
  if (!supported) throw unsupportedNode(path, node);
  return node;
}

function exactTreeEntry(treeResponse: unknown, segment: string, path: string): ImmutableGitNode | null {
  if (!treeResponse || typeof treeResponse !== "object") throw malformedTree(path, "tree response is not an object");
  const response = treeResponse as Record<string, unknown>;
  if (!Array.isArray(response.tree)) throw malformedTree(path, "tree field is not an array");

  let match: ImmutableGitNode | undefined;
  for (const rawEntry of response.tree) {
    if (!rawEntry || typeof rawEntry !== "object") throw malformedTree(path, "tree entry is not an object");
    const entry = validateNode(rawEntry as Record<string, unknown>, path);
    if (entry.path !== segment) continue;
    if (match) throw new Error(`GitHub immutable tree contains duplicate exact entry ${JSON.stringify(segment)} while resolving ${path}.`);
    match = entry;
  }

  if (match) return match;
  if (response.truncated === false) return null;
  throw incompleteTree(path, segment);
}

export async function readImmutableGitFile(
  path: string,
  commitSha: string,
  adapter: ImmutableGitReadAdapter,
): Promise<{ bytes: Uint8Array; sha: string } | null> {
  const segments = immutablePathSegments(path);
  const commit = await adapter.getCommit(commitSha);
  if (!GIT_OBJECT_SHA.test(commit.treeSha)) {
    throw new Error(`GitHub immutable commit has invalid tree SHA: ${commitSha}.`);
  }

  let treeSha = commit.treeSha;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const tree = await adapter.getTree(treeSha);
    const node = exactTreeEntry(tree, segment, path);
    if (!node) return null;

    const final = index === segments.length - 1;
    if (!final) {
      if (node.type === "tree") {
        treeSha = node.sha;
        continue;
      }
      return null;
    }

    if (node.type === "tree" || node.type === "commit") return null;
    if (node.mode === "120000") {
      throw new Error(`GitHub immutable managed path symlink is unsupported: ${path}.`);
    }
    const bytes = await adapter.getBlob(node.sha);
    return { bytes, sha: node.sha };
  }

  return null;
}
