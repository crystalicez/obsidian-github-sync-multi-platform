import { ENCRYPTED_PACKS_ROOT } from "./constants";

const PACK_ARCHIVE_MAGIC = "OGSPACK1";
const HEADER_LENGTH_BYTES = 4;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface PackArchiveFileInput {
  path: string;
  mtime: number;
  bytes: Uint8Array;
}

export interface PackArchiveFileOutput extends PackArchiveFileInput {}

interface PackArchiveHeaderFile {
  path: string;
  mtime: number;
  offset: number;
  size: number;
}

interface PackArchiveHeader {
  magic: typeof PACK_ARCHIVE_MAGIC;
  files: PackArchiveHeaderFile[];
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
      const entry = { path: file.path, mtime: file.mtime, offset, size: file.bytes.byteLength };
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
    return { path: file.path, mtime: file.mtime, bytes: archive.subarray(start, end) };
  });
}
