import { sha256Hex, utf8ToBytes } from "../bytes"
import type { V4IndexFileRecord } from "./local-index"

function remoteHashRecord(record: V4IndexFileRecord): V4IndexFileRecord {
  const { dirty: _dirty, ...remote } = record
  return remote
}

export function canonicalV4ShardRecords(records: Iterable<V4IndexFileRecord>): V4IndexFileRecord[] {
  return [...records]
    .map(remoteHashRecord)
    .sort((left, right) => left.pathId.localeCompare(right.pathId))
}

export async function hashV4ShardRecords(records: Iterable<V4IndexFileRecord>): Promise<string> {
  return sha256Hex(utf8ToBytes(JSON.stringify(canonicalV4ShardRecords(records))))
}
