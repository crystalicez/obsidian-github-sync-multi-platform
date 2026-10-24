# D76 — Pinned-source V4 re-encryption object stream (not a publisher)

Date: 2026-10-24 (Asia/Bangkok). Based on clean/pushed D75 `3625d678c72cb520f5ed96dbe9b74f986dcc6510`.

## Approved architecture and scope

The owner approved option A: a **new orphan root branch within the same physical GitHub repository**, preserving the prior branch for recovery and restoring on a second device before any other device switches. The owner has NOT yet approved whether all still-old devices must pause syncing throughout migration and cutover. D76 adds **no GitHub mutation, ref creation, vault rewrite, user settings change, UI or automatic cutover**.

`src/lib/v4/reencryption-stream-transcode.ts` introduces `createV4ReencryptedObjectStream()` as a per-logical-file, bounded ciphertext preparation helper. This is a *pre-publication building block*, not an executable migration or a substitute for a complete snapshot/backup/WAL gate.

## Mechanics

1. Validate the D74 same-repository orphan-branch plan, source/destination repo identities, compatible encrypted V4 layouts, PBKDF2 bounds (new 600k–1.2M), **fresh destination KDF salt**, distinct source and destination content/path key bytes, and non-deleted/non-dirty source record. Validate exact source HMAC `pathId` and remote opaque storage paths using `assertV4RemoteRecordSet`.
2. Every source object read goes through `readSourceObject(path, plan.pinnedSourceCommitSha)`. The trustworthiness of that callback must be supplied by the production D70–D72 **exact-commit** GitHub reader, not by arbitrary UI code. `verifySourceStillPinned()` must be a trusted source HEAD/repository observation; the helper invokes it at start, during object consumption and after the last read. Changes fail the stream.
3. Reuse production V4 storage codec on old `single` or `pack` payloads (AES-GCM authentication plus per-record SHA-256) or decrypt old `chunked` parts sequentially using their source file-ID/version/part-index AES-GCM AAD. Do **not** combine the entire chunked logical file into memory; each source part is released/zeroed after consumption.
4. Re-encode via the production `V4StorageCodec.prepareFromSource()`, not by reusing old encrypted blobs or renaming remote paths. Generate a new **cryptorandom 24-byte opaque fileId**, new keyed pathId, different object path and destination AES-GCM ciphertext. Old pack entries are emitted as new independent single/chunked file objects; all logical SHA-256 and byte sizes remain invariant.
5. Set new plaintext **part size to 8 MiB minus V4 authenticated-payload overhead** so every emitted encrypted blob fits the owner's fixed maximum **8 MiB REST writer payload**. This guards ciphertext *size*, not just plaintext size.
6. The existing V4 streamed codec chooses `single` storage by plaintext size up to 8 MiB; a plaintext file within the final AES overhead bytes below the 8 MiB ceiling could cause an oversized single ciphertext blob. D76 **fail-closes** specifically for source sizes in `(8 MiB - encrypted overhead, 8 MiB]` until the general codec's single/chunked size selection is corrected and regression tested. Do not silently reconfigure the owner's 8 MiB part policy.

## Strict publication rule

The method returns a **`V4PreparedObjectStream` only**, not a publish or a verified migration. The caller must fully consume every object, authenticate **all** old parts and compare the final decrypted SHA-256 and size in `finalize()` before including any destination record in a published index/head/root commit. A tampered *later* source part can occur after an earlier new encrypted object was generated; that earlier object is **not a valid migration** and must never gain a published reference without finalization. Immutable blobs staged before a failed attempt may be unreachable; recovery needs separate journal/cleanup policy.

This routine does not yet verify the full source inventory, independent backup, source-device WAL cleanliness, local changed files, destination complete-file count, device coordination, or other-client write fences. The keys are provided by a trusted caller, not derived here, and zeroing old/new WebCrypto keys after the entire migration remains the coordinator's responsibility. Old pack decoding is still whole-buffer within the existing production reader's memory policy; large legacy packs need a separate bounded-performance review.

## Validation evidence

Fail-first test against absent helper then `tests/v4/reencryption-stream-transcode.test.ts` **7/7 GREEN**:
- Unicode single-file new key/new fileId/new object path and identical plaintext SHA-256;
- two packed records become independent new encrypted objects without old pack reuse;
- real >8 MiB chunked source transcodes into two REST-safe new ciphertext objects and exactly matching plaintext;
- invalid ciphertext and wrong expected hash fail without a publishable record;
- authenticated empty file round trip;
- corrupted later source part blocks finalization even if earlier output was yielded;
- same repoId/salt/key, tombstone/dirty state, stale source HEAD, unsafe target version and near-8 MiB ciphertext boundary all fail closed.

Offline frozen install, Maximum Strict TypeScript production build, full fast/resource/recovery/feasibility, E2E compile and packaging validators are run in the isolated D76 worktree; no live GitHub or installed Obsidian test for this newly added helper. **Release gate still `blocked`, only topology approved**, other six criteria pending.

## Next work

- Correct the existing general V4 single/chunked ciphertext-size threshold, then remove the fail-closed narrow boundary with tests.
- Build a trusted exact-commit **whole source inventory** to D76 per-record stream + independent verified backup + output inventory hash/size verifier; commit an orphan root only after **all** records finalize and records/objects are complete.
- Add cancellation/restart-safe durable journal and independent second-device acceptance.
- Ask owner for explicit old-device pause policy before writing any automatic migration/cutover/stale-client behavior. This stage intentionally makes no such decision.
