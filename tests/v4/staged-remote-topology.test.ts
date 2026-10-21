import assert from "node:assert/strict"
import test from "node:test"
import { sha256Hex } from "../../src/lib/bytes"
import { assertV4RemoteRecordSet } from "../../src/lib/v4/remote-index"
import type { V4IndexFileRecord } from "../../src/lib/v4/local-index"
import type { V4RemoteConfig } from "../../src/lib/v4/protocol-types"

const plain: V4RemoteConfig = { formatVersion: 4, repoId: "owner/repo#main", mode: "plaintext", pathLayout: "plaintext-v1" }

async function record(path: string, id: string): Promise<V4IndexFileRecord> {
  return { path, pathId: await sha256Hex(new TextEncoder().encode(`path:${path}`)),
    fileId: id, plaintextSha256: "a".repeat(64), size: 1, mtime: 1, remoteVersion: "v1",
    remotePath: path, storage: "single" }
}

test("remote record set safely accepts distinct files across distinct directories", async () => {
  const records = await Promise.all([record("Notes/A.md", "a"), record("Notes/B.md", "b"),
    record("Other/a.md", "c")])
  await assert.doesNotReject(() => assertV4RemoteRecordSet(records, plain))
})

test("remote record set rejects case-fold and Unicode NFC collisions before download", async () => {
  for (const [first, second] of [
    ["Notes/A.md", "notes/a.md"],
    ["Café.md", "Cafe\u0301.md"],
    ["FOO/Bar.md", "foo/bar.md"],
  ]) {
    const records = await Promise.all([record(first, "a"), record(second, "b")])
    await assert.rejects(() => assertV4RemoteRecordSet(records, plain), /collision|canonical|case|normalization/iu)
  }
})

test("remote record set rejects file/directory ancestor collisions, including canonical aliases", async () => {
  for (const [first, second] of [
    ["Dir", "Dir/file.md"],
    ["Dir", "dir/file.md"],
    ["Café", "Cafe\u0301/file.md"],
  ]) {
    const records = await Promise.all([record(first, "a"), record(second, "b")])
    await assert.rejects(() => assertV4RemoteRecordSet(records, plain), /collision|ancestor|topology/iu)
  }
})
