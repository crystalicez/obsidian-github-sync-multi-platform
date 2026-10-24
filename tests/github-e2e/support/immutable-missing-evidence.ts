/**
 * Failure-only synthetic E2E diagnostics. Inspect immutable Git objects with
 * separately issued, read-only requests AFTER the original read returned null.
 * Evidence is non-atomic. Never retry publication or substitute these bytes.
 */
const SHA = /^[0-9a-f]{40}$/u
const MAX_SEGMENTS = 16

type ObjectKind = "commit" | "tree"
type Outcome = "invalid-ref" | "invalid-path" | "http-unavailable" | "identity-mismatch" | "malformed-response"
  | "incomplete-tree" | "absent-in-complete-tree" | "unexpected-node" | "blob-present-in-tree" | "observation-failed"

export interface ImmutableReadSample {
  kind: ObjectKind
  requestedSha: string
  httpStatus: number
  receivedSha: string | null
  /** Used only for tree nodes; no payload bytes or remote secrets are logged. */
  segment?: string
  nodeType?: "tree" | "blob" | "commit"
  nodeSha?: string
  truncated?: boolean | null
}

export interface ImmutableMissingEvidence {
  kind: "immutable-missing-object-read-only-evidence"
  path: string
  immutableCommitSha: string | null
  outcome: Outcome
  observations: ImmutableReadSample[]
}

interface Response {
  status: number
  json?: unknown
}

interface Adapter {
  getCommit: (sha: string) => Promise<Response>
  getTree: (sha: string) => Promise<Response>
}

function recordObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
function validSha(value: unknown): string | null {
  return typeof value === "string" && SHA.test(value) ? value : null
}
function status(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : 0
}

export async function inspectImmutableMissingObject(
  path: string,
  ref: string | undefined,
  adapter: Adapter,
): Promise<ImmutableMissingEvidence> {
  const evidence: ImmutableMissingEvidence = {
    kind: "immutable-missing-object-read-only-evidence",
    path,
    immutableCommitSha: validSha(ref),
    outcome: "invalid-ref",
    observations: [],
  }
  if (!evidence.immutableCommitSha) return evidence
  const segments = path.split("/")
  if (segments.length === 0 || segments.length > MAX_SEGMENTS
    || segments.some(segment => segment === "" || segment === "." || segment === "..")) {
    evidence.outcome = "invalid-path"
    return evidence
  }

  try {
    const commitResponse = await adapter.getCommit(evidence.immutableCommitSha)
    const commitBody = recordObject(commitResponse.json)
    const commitSha = validSha(commitBody?.["sha"])
    evidence.observations.push({
      kind: "commit", requestedSha: evidence.immutableCommitSha,
      httpStatus: status(commitResponse.status), receivedSha: commitSha,
    })
    if (commitResponse.status !== 200) { evidence.outcome = "http-unavailable"; return evidence }
    if (commitSha !== evidence.immutableCommitSha) {
      evidence.outcome = commitSha ? "identity-mismatch" : "malformed-response"
      return evidence
    }
    const commitTree = recordObject(commitBody?.["tree"])
    let treeSha = validSha(commitTree?.["sha"])
    if (!treeSha) { evidence.outcome = "malformed-response"; return evidence }

    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!
      const treeResponse = await adapter.getTree(treeSha)
      const treeBody = recordObject(treeResponse.json)
      const receivedSha = validSha(treeBody?.["sha"])
      const sample: ImmutableReadSample = {
        kind: "tree", requestedSha: treeSha,
        httpStatus: status(treeResponse.status), receivedSha, segment,
      }
      evidence.observations.push(sample)
      if (treeResponse.status !== 200) { evidence.outcome = "http-unavailable"; return evidence }
      if (receivedSha !== treeSha) {
        evidence.outcome = receivedSha ? "identity-mismatch" : "malformed-response"
        return evidence
      }
      const entries = treeBody?.["tree"]
      if (!Array.isArray(entries)) { evidence.outcome = "malformed-response"; return evidence }
      sample.truncated = typeof treeBody?.["truncated"] === "boolean"
        ? treeBody["truncated"] as boolean : null
      const matching = entries.filter(entry => recordObject(entry)?.["path"] === segment)
      if (matching.length > 1) { evidence.outcome = "malformed-response"; return evidence }
      if (matching.length === 0) {
        evidence.outcome = sample.truncated === false ? "absent-in-complete-tree" : "incomplete-tree"
        return evidence
      }
      const node = recordObject(matching[0])
      const nodeType = node?.["type"]
      const nodeSha = validSha(node?.["sha"])
      if (nodeType !== "blob" && nodeType !== "tree" && nodeType !== "commit") {
        evidence.outcome = "malformed-response"
        return evidence
      }
      sample.nodeType = nodeType
      if (!nodeSha) { evidence.outcome = "malformed-response"; return evidence }
      sample.nodeSha = nodeSha
      const last = index === segments.length - 1
      if (last) {
        evidence.outcome = nodeType === "blob" && (node?.["mode"] === "100644" || node?.["mode"] === "100755")
          ? "blob-present-in-tree" : "unexpected-node"
        return evidence
      }
      if (nodeType !== "tree" || node?.["mode"] !== "040000") {
        evidence.outcome = "unexpected-node"
        return evidence
      }
      treeSha = nodeSha
    }
  } catch {
    // Fixed code; never include exception text, HTTP JSON, bearer token or bytes.
    evidence.outcome = "observation-failed"
  }
  return evidence
}
