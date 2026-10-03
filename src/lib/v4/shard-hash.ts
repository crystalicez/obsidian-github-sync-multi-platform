import { sha256Hex, utf8ToBytes } from "../bytes"
import type { V4IndexFileRecord } from "./local-index"

export function toV4RemoteRecord(record: V4IndexFileRecord): V4IndexFileRecord {
  const { dirty: _dirty, deleted: _deleted, ...remote } = record
  return remote
}

export function canonicalV4ShardRecords(records: Iterable<V4IndexFileRecord>): V4IndexFileRecord[] {
  return [...records]
    .map(toV4RemoteRecord)
    .sort((left, right) => left.pathId.localeCompare(right.pathId))
}

export async function hashV4ShardRecords(records: Iterable<V4IndexFileRecord>): Promise<string> {
  return sha256Hex(utf8ToBytes(JSON.stringify(canonicalV4ShardRecords(records))))
}
