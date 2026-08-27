import { randomUUID } from "node:crypto";
import { parseStableTriple } from "./release-metadata.mjs";
import { runCommand } from "./local-release-lib.mjs";

const SHA_RE = /^[0-9a-f]{40}$/u;

function requireSuccess(result, label) {
  if (!result || result.status !== 0) {
    throw new Error(`${label} failed`);
  }
  return result;
}

function text(result) {
  return String(result.stdout ?? "").trim();
}

function requireSha(value, label) {
  if (!SHA_RE.test(value ?? "")) throw new Error(`${label} returned an invalid object SHA`);
  return value;
}

export function readHeadSha({ runner = runCommand, cwd } = {}) {
  const result = requireSuccess(runner("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }), "HEAD lookup");
  return requireSha(text(result), "HEAD lookup");
}

export function requireCleanMaster({ runner = runCommand, cwd } = {}) {
  const status = requireSuccess(runner("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd, encoding: "utf8" }), "Git status");
  if (String(status.stdout ?? "") !== "") throw new Error("Working tree must be clean");
  const branch = requireSuccess(runner("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }), "Git branch lookup");
  if (text(branch) !== "master") throw new Error("Local qualification/release requires branch master");
  return readHeadSha({ runner, cwd });
}

export function lookupRemoteRef({ runner = runCommand, cwd, remote = "origin", ref } = {}) {
  const result = runner("git", ["ls-remote", "--refs", remote, ref], { cwd, encoding: "utf8" });
  if (!result || result.status !== 0) throw new Error(`Remote ref lookup failed: ${ref}`);
  const output = String(result.stdout ?? "").trim();
  if (!output) return { kind: "absent" };
  const rows = output.split(/\r?\n/u).filter(Boolean);
  if (rows.length !== 1) throw new Error(`Ambiguous remote ref response: ${ref}`);
  const [objectSha, returnedRef, ...extra] = rows[0].trim().split(/\s+/u);
  if (extra.length !== 0 || returnedRef !== ref) throw new Error(`Malformed remote ref response: ${ref}`);
  return { kind: "present", objectSha: requireSha(objectSha, "Remote ref lookup") };
}

export function readRemoteMasterSha(options = {}) {
  const state = lookupRemoteRef({ ...options, ref: "refs/heads/master" });
  if (state.kind !== "present") throw new Error("Remote master is absent");
  return state.objectSha;
}

export function createAnnotatedTagObject({ runner = runCommand, cwd, targetSha, tagName, message } = {}) {
  requireSha(targetSha, "Tag target");
  if (typeof tagName !== "string" || tagName === "" || /[\s~^:?*[\\]/u.test(tagName) || tagName.includes("..")) {
    throw new Error("Invalid annotated tag name");
  }
  if (typeof message !== "string" || !message.endsWith("\n") || message.endsWith("\n\n")) throw new Error("Annotated tag message must end with exactly one newline");
  requireSuccess(runner("git", ["check-ref-format", `refs/tags/${tagName}`], { cwd, encoding: "utf8" }), "Annotated tag name validation");
  const identResult = requireSuccess(runner("git", ["var", "GIT_COMMITTER_IDENT"], { cwd, encoding: "utf8" }), "Git committer identity lookup");
  const ident = text(identResult);
  if (!ident) throw new Error("Git committer identity is missing");
  const body = `object ${targetSha}\ntype commit\ntag ${tagName}\ntagger ${ident}\n\n${message}`;
  const result = requireSuccess(runner("git", ["mktag"], { cwd, encoding: "utf8", input: body }), "Annotated tag object creation");
  return requireSha(text(result), "Annotated tag object creation");
}

export function inspectTagObject({ runner = runCommand, cwd, objectSha } = {}) {
  requireSha(objectSha, "Tag object");
  const typeResult = requireSuccess(runner("git", ["cat-file", "-t", objectSha], { cwd, encoding: "utf8" }), "Tag object type inspection");
  if (text(typeResult) !== "tag") throw new Error("Qualification object is not an annotated tag object");
  const contentResult = requireSuccess(runner("git", ["cat-file", "-p", objectSha], { cwd, encoding: "utf8" }), "Tag object inspection");
  const content = String(contentResult.stdout ?? "");
  const splitAt = content.indexOf("\n\n");
  if (splitAt < 0) throw new Error("Annotated tag object is malformed");
  const headerLines = content.slice(0, splitAt).split("\n");
  const headers = new Map();
  for (const line of headerLines) {
    const space = line.indexOf(" ");
    if (space <= 0) throw new Error("Annotated tag object header is malformed");
    const key = line.slice(0, space);
    if (headers.has(key)) throw new Error(`Annotated tag object has duplicate ${key} header`);
    headers.set(key, line.slice(space + 1));
  }
  const allowedHeaders = new Set(["object", "type", "tag", "tagger"]);
  for (const key of headers.keys()) {
    if (!allowedHeaders.has(key)) throw new Error(`Annotated tag object has unexpected ${key} header`);
  }
  for (const key of allowedHeaders) {
    if (!headers.has(key)) throw new Error(`Annotated tag object is missing ${key} header`);
  }
  const targetSha = requireSha(headers.get("object"), "Annotated tag target");
  const targetType = headers.get("type");
  const tagName = headers.get("tag");
  if (typeof targetType !== "string" || !targetType) throw new Error("Annotated tag object is missing target type");
  if (typeof tagName !== "string" || !tagName) throw new Error("Annotated tag object is missing tag name");
  const message = content.slice(splitAt + 2);
  return { objectSha, targetSha, targetType, tagName, message };
}

export function fetchAndInspectObservedQualificationTag({
  runner = runCommand,
  cwd,
  remote = "origin",
  ref,
  randomId = () => randomUUID().replaceAll("-", ""),
} = {}) {
  const observed = lookupRemoteRef({ runner, cwd, remote, ref });
  if (observed.kind === "absent") return observed;
  const suffix = randomId();
  if (!/^[A-Za-z0-9_-]{6,64}$/u.test(suffix ?? "")) throw new Error("Unsafe temporary inspection ref id");
  const tempRef = `refs/local-qualification-inspect/${suffix}`;
  try {
    requireSuccess(runner("git", ["fetch", "--no-tags", remote, `${ref}:${tempRef}`], { cwd, encoding: "utf8" }), "Qualification ref fetch");
    const resolved = requireSuccess(runner("git", ["rev-parse", tempRef], { cwd, encoding: "utf8" }), "Qualification temp-ref resolution");
    const fetchedSha = requireSha(text(resolved), "Qualification temp-ref resolution");
    if (fetchedSha !== observed.objectSha) throw new Error("Remote qualification ref changed during inspection");
    return { kind: "present", objectSha: observed.objectSha, tag: inspectTagObject({ runner, cwd, objectSha: observed.objectSha }) };
  } finally {
    runner("git", ["update-ref", "-d", tempRef], { cwd, encoding: "utf8" });
  }
}

export function readCommittedBlob({ runner = runCommand, cwd, path, rev = "HEAD" } = {}) {
  if (typeof path !== "string" || path === "" || path.includes("\0") || path.includes("\n") || path.includes("\r")) throw new Error("Invalid committed blob path");
  const result = requireSuccess(runner("git", ["show", `${rev}:${path}`], { cwd, encoding: null }), `Committed blob read: ${path}`);
  if (!Buffer.isBuffer(result.stdout)) return Buffer.from(result.stdout ?? "");
  return result.stdout;
}

export function listRemoteStableTags({ runner = runCommand, cwd, remote = "origin" } = {}) {
  const result = requireSuccess(runner("git", ["ls-remote", "--tags", "--refs", remote], { cwd, encoding: "utf8" }), "Remote tag listing");
  const output = String(result.stdout ?? "").trim();
  if (!output) return [];
  const stable = [];
  for (const row of output.split(/\r?\n/u).filter(Boolean)) {
    const [objectSha, ref, ...extra] = row.trim().split(/\s+/u);
    if (extra.length !== 0 || !ref?.startsWith("refs/tags/")) throw new Error("Malformed remote tag listing");
    requireSha(objectSha, "Remote tag listing");
    const name = ref.slice("refs/tags/".length);
    if (parseStableTriple(name)) stable.push({ name, objectSha });
  }
  return stable;
}
