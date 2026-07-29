import { V4_PART_BYTES } from "./large-files"
import { estimateV4GitBlobTransportBytes } from "./resource-controller"

const MiB = 1024 * 1024

// GitHub documents a secondary content-generation ceiling around 500 mutations/hour.
// Keep 100 operations in reserve for metadata, bootstrap, retries, and other writers.
export const V4_GITHUB_SAFE_CONTENT_MUTATIONS_PER_REVISION = 400

export interface V4PartWritePolicyInput {
  logicalBytes: number
  maxTransportTransientBytes: number
  maxContentMutations?: number
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer.`)
}

function largestTransportSafeMiB(maxTransportTransientBytes: number): number {
  const maxMiB = Math.floor(V4_PART_BYTES / MiB)
  let low = 0
  let high = maxMiB
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (estimateV4GitBlobTransportBytes(mid * MiB) <= maxTransportTransientBytes) low = mid
    else high = mid - 1
  }
  return low * MiB
}

export function selectV4WriterPartBytes(input: V4PartWritePolicyInput): number {
  assertNonNegativeSafeInteger(input.logicalBytes, "logicalBytes")
  assertNonNegativeSafeInteger(input.maxTransportTransientBytes, "maxTransportTransientBytes")
  const mutationBudget = input.maxContentMutations ?? V4_GITHUB_SAFE_CONTENT_MUTATIONS_PER_REVISION
  if (!Number.isSafeInteger(mutationBudget) || mutationBudget < 1) throw new TypeError("maxContentMutations must be a positive safe integer.")

  const transportSafe = largestTransportSafeMiB(input.maxTransportTransientBytes)
  const minimumForMutationHeadroom = input.logicalBytes === 0
    ? MiB
    : Math.ceil(Math.ceil(input.logicalBytes / mutationBudget) / MiB) * MiB
  const selected = Math.min(V4_PART_BYTES, transportSafe)
  if (selected < Math.max(MiB, minimumForMutationHeadroom)) {
    throw new Error(`There is no safe V4 writer part size for ${input.logicalBytes} bytes under the configured transport and mutation budgets.`)
  }
  return selected
}
