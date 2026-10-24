import { isV4PublicationRaceError } from "../../../src/lib/v4/publication-race"

/**
 * Test-only, failure-triggered evidence collection. Never resolves/overrides a
 * publication failure or issues a write. Observations occur AFTER the failure,
 * not atomically alongside the original GitHub REST response.
 */
export interface V4HeadNullObservation {
  status: number
  sha?: string
  treeSha?: string
}

export interface V4HeadNullEvidence {
  kind: "pre-publish-head-null-read-only-evidence"
  device: string
  expectedHeadSha: string
  localIndexCommitSha: string | null
  branch: V4HeadNullObservation | { error: string }
  expectedCommit: V4HeadNullObservation | { error: string }
}

const IMMUTABLE_SHA = /^[0-9a-f]{40}$/u

function sanitizedObservation(input: V4HeadNullObservation): V4HeadNullObservation {
  const status = Number.isInteger(input.status) && input.status >= 100 && input.status <= 599
    ? input.status
    : 0
  const result: V4HeadNullObservation = { status }
  if (typeof input.sha === "string" && IMMUTABLE_SHA.test(input.sha)) result.sha = input.sha
  if (typeof input.treeSha === "string" && IMMUTABLE_SHA.test(input.treeSha)) result.treeSha = input.treeSha
  return result
}

export async function observeV4PrePublishHeadNull(
  error: unknown,
  options: {
    device: string
    localIndexCommitSha: string | undefined
    readBranch: () => Promise<V4HeadNullObservation>
    readExpectedCommit: (sha: string) => Promise<V4HeadNullObservation>
    report: (evidence: V4HeadNullEvidence) => void
  },
): Promise<void> {
  if (!isV4PublicationRaceError(error)
    || error.phase !== "pre-publish"
    || error.publicationOutcome !== "not-published"
    || error.observedHeadSha !== null
    || typeof error.expectedHeadSha !== "string"
    || !IMMUTABLE_SHA.test(error.expectedHeadSha)) return

  const read = async (action: () => Promise<V4HeadNullObservation>): Promise<V4HeadNullObservation | { error: string }> => {
    try { return sanitizedObservation(await action()) }
    catch { return { error: "read-only-observation-failed" } }
  }
  const evidence: V4HeadNullEvidence = {
    kind: "pre-publish-head-null-read-only-evidence",
    device: options.device,
    expectedHeadSha: error.expectedHeadSha,
    localIndexCommitSha: options.localIndexCommitSha && IMMUTABLE_SHA.test(options.localIndexCommitSha)
      ? options.localIndexCommitSha : null,
    branch: await read(options.readBranch),
    expectedCommit: await read(() => options.readExpectedCommit(error.expectedHeadSha!)),
  }
  try { options.report(evidence) } catch { /* Logging must not change failure behavior. */ }
}
