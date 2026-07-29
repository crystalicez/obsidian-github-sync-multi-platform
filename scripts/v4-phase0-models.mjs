const DEFAULT_METADATA_BLOB_MUTATIONS = 4; // config + changed shard + head + one journal page
const DEFAULT_PUBLICATION_MUTATIONS = 3; // tree + commit + ref create/update
const DEFAULT_METADATA_BYTES = 256 * 1024;

export function compareVersions(a, b) {
  const left = String(a).split(".").map(part => Number.parseInt(part, 10) || 0);
  const right = String(b).split(".").map(part => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

export function base64EncodedBytes(byteLength) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new TypeError("byteLength must be a non-negative safe integer");
  return 4 * Math.ceil(byteLength / 3);
}

export function estimateGitBlobTransportMemory(rawBytes, { encrypted = false, jsonOverheadBytes = 64 } = {}) {
  if (!Number.isSafeInteger(rawBytes) || rawBytes < 0) throw new TypeError("rawBytes must be a non-negative safe integer");
  const ciphertextBytes = encrypted ? rawBytes + 16 : rawBytes;
  const base64Bytes = base64EncodedBytes(ciphertextBytes);
  const jsonBodyBytes = base64Bytes + jsonOverheadBytes;
  return {
    rawBytes,
    ciphertextBytes,
    base64Bytes,
    jsonBodyBytes,
    // Conservative simultaneous-residency model for the current code path.
    // Runtime measurements may be higher due to engine/request copies.
    estimatedPeakBytes: rawBytes + ciphertextBytes + base64Bytes + jsonBodyBytes,
  };
}

export function modelV4LargeFileRevision(logicalBytes, partBytes, options = {}) {
  if (!Number.isSafeInteger(logicalBytes) || logicalBytes <= 0) throw new TypeError("logicalBytes must be a positive safe integer");
  if (!Number.isSafeInteger(partBytes) || partBytes <= 0) throw new TypeError("partBytes must be a positive safe integer");
  const metadataBlobMutations = options.metadataBlobMutations ?? DEFAULT_METADATA_BLOB_MUTATIONS;
  const publicationMutations = options.publicationMutations ?? DEFAULT_PUBLICATION_MUTATIONS;
  const mutationSpacingMs = options.mutationSpacingMs ?? 1_000;
  const encryptionOverheadPerPart = options.encryptionOverheadPerPart ?? 16;
  const metadataBytes = options.metadataBytes ?? DEFAULT_METADATA_BYTES;
  const bootstrapMutations = options.bootstrapMutations ?? 0;
  const partCount = Math.ceil(logicalBytes / partBytes);
  const dataBlobMutations = partCount;
  const contentMutations = dataBlobMutations + metadataBlobMutations + publicationMutations + bootstrapMutations;
  return {
    logicalBytes,
    partBytes,
    partCount,
    dataBlobMutations,
    metadataBlobMutations,
    publicationMutations,
    bootstrapMutations,
    contentMutations,
    minimumPacedMutationMs: Math.max(0, contentMutations - 1) * mutationSpacingMs,
    estimatedRepositoryBytesPerRevision: logicalBytes + (partCount * encryptionOverheadPerPart) + metadataBytes,
  };
}
