import { ENCRYPTED_PACKS_ROOT } from "./constants";

const PACK_ARCHIVE_MAGIC = "OGSPACK1";
const HEADER_LENGTH_BYTES = 4;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface PackArchivePlanningInput {
  path: string;
  mtime: number;
  size: number;
  plaintextSha256?: string;
}

export interface PackArchiveFileInput {
  path: string;
  mtime: number;
  bytes: Uint8Array;
  plaintextSha256?: string;
}

export interface PackArchiveFileOutput extends PackArchiveFileInput {}

interface PackArchiveHeaderFile {
  path: string;
  mtime: number;
  offset: number;
  size: number;
  checksum: number;
  plaintextSha256?: string;
}

interface PackArchiveHeader {
  magic: typeof PACK_ARCHIVE_MAGIC;
  files: PackArchiveHeaderFile[];
}

function base64UrlEncodedLength(byteLength: number): number {
  const padded = Math.ceil(byteLength / 3) * 4;
  const remainder = byteLength % 3;
  return remainder === 0 ? padded : padded - (3 - remainder);
}

const ENCRYPTED_PAYLOAD_JSON_OVERHEAD_BYTES = textEncoder.encode(JSON.stringify({ nonce: "", ciphertext: "" })).byteLength;

export function estimateEncryptedPayloadJsonBytes(plaintextBytes: number): number {
  return ENCRYPTED_PAYLOAD_JSON_OVERHEAD_BYTES + base64UrlEncodedLength(12) + base64UrlEncodedLength(plaintextBytes + 16);
}

const PACK_HEADER_PREFIX_BYTES = textEncoder.encode(`{"magic":"${PACK_ARCHIVE_MAGIC}","files":[`).byteLength;
const PACK_HEADER_SUFFIX_BYTES = textEncoder.encode("]}").byteLength;

export function estimatePackHeaderEntryBytes(file: PackArchivePlanningInput, offset: number): number {
  return textEncoder.encode(JSON.stringify({ path: file.path, mtime: file.mtime, offset, size: file.size, checksum: 4294967295, plaintextSha256: file.plaintextSha256 })).byteLength;
}

export function estimatePackArchiveBytesFromParts(totalFileBytes: number, fileCount: number, headerEntriesBytes: number): number {
  const commaBytes = Math.max(0, fileCount - 1);
  return HEADER_LENGTH_BYTES + PACK_HEADER_PREFIX_BYTES + headerEntriesBytes + commaBytes + PACK_HEADER_SUFFIX_BYTES + totalFileBytes;
}

export function estimatePackArchiveBytes(files: PackArchivePlanningInput[]): number {
  let offset = 0;
  let headerEntriesBytes = 0;
  for (const file of files) {
    headerEntriesBytes += estimatePackHeaderEntryBytes(file, offset);
    offset += file.size;
  }
  return estimatePackArchiveBytesFromParts(offset, files.length, headerEntriesBytes);
}

export function estimateEncryptedPackPayloadBytes(files: PackArchivePlanningInput[]): number {
  return estimateEncryptedPayloadJsonBytes(estimatePackArchiveBytes(files));
}
function checksum32(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.byteLength; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function packObjectPathForId(id: string): string {
  return `${ENCRYPTED_PACKS_ROOT}/${id}.pack.enc`;
}

export function encodePackArchive(files: PackArchiveFileInput[]): Uint8Array {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  let offset = 0;
  const header: PackArchiveHeader = {
    magic: PACK_ARCHIVE_MAGIC,
    files: sorted.map(file => {
      const entry = { path: file.path, mtime: file.mtime, offset, size: file.bytes.byteLength, checksum: checksum32(file.bytes), plaintextSha256: file.plaintextSha256 };
      offset += file.bytes.byteLength;
      return entry;
    }),
  };
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  const output = new Uint8Array(HEADER_LENGTH_BYTES + headerBytes.byteLength + offset);
  new DataView(output.buffer, output.byteOffset, HEADER_LENGTH_BYTES).setUint32(0, headerBytes.byteLength, false);
  output.set(headerBytes, HEADER_LENGTH_BYTES);
  let dataOffset = HEADER_LENGTH_BYTES + headerBytes.byteLength;
  for (const file of sorted) {
    output.set(file.bytes, dataOffset);
    dataOffset += file.bytes.byteLength;
  }
  return output;
}

export function decodePackArchive(archive: Uint8Array): PackArchiveFileOutput[] {
  if (archive.byteLength < HEADER_LENGTH_BYTES) throw new Error("Invalid encrypted pack archive: missing header length.");
  const headerLength = new DataView(archive.buffer, archive.byteOffset, HEADER_LENGTH_BYTES).getUint32(0, false);
  const headerStart = HEADER_LENGTH_BYTES;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > archive.byteLength) throw new Error("Invalid encrypted pack archive: truncated header.");
  const header = JSON.parse(textDecoder.decode(archive.subarray(headerStart, headerEnd))) as PackArchiveHeader;
  if (header.magic !== PACK_ARCHIVE_MAGIC) throw new Error("Invalid encrypted pack archive: bad magic.");
  const dataStart = headerEnd;
  return header.files.map(file => {
    const start = dataStart + file.offset;
    const end = start + file.size;
    if (end > archive.byteLength) throw new Error(`Invalid encrypted pack archive: truncated file ${file.path}.`);
    const bytes = archive.subarray(start, end);
    if (checksum32(bytes) !== file.checksum) throw new Error(`Encrypted pack archive integrity check failed for ${file.path}.`);
    return { path: file.path, mtime: file.mtime, bytes, plaintextSha256: file.plaintextSha256 };
  });
}
