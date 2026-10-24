# D69 — Read-only authenticated object verification before Re-encryption

Date: 2026-10-24 (Asia/Bangkok). Isolated audit branch `audit/2026-10-24-d69-reencryption-content-verifier`, based on D68 `c1ac92e`.

## Intent and explicit scope

The owner requires a fully functional, safe Re-encryption Wizard before the first release. Destination architecture **A versus B is still undecided**. D69 adds a topology-agnostic, read-only content verification function, `verifyV4ReencryptionSourceObjects`, in `src/lib/v4/reencryption-content-verifier.ts`. It performs **no vault writes, remote writes, settings/secret changes, Force Push/Pull, key rotation or cutover**.

### Trusted inputs

The caller must obtain source config, head and **every decoded index shard from the exact same immutable Git commit**, authenticated using the appropriate old keyring and remote protocol AAD. It supplies:

- `readPinnedObject(path, exactCommitSha)` that **must fetch those object bytes from the exact SHA**, never from an unpinned branch ref, and returns `null` on missing object;
- `readCurrentSourceHeadSha()`, an authenticated fresh source branch-head observer to detect if the mutable source branch differs from the frozen commit;
- optional cancellation signal.

The returned result can be trusted only to the extent that these callbacks are correctly implemented and the input snapshot came from authenticated GitHub reads. A callback supplied by the UI or a mutable/misleading reader **must not** be considered evidence; future production integration needs a guarded/typed GitHub adapter and a trusted coordinator, not user-provided checkboxes.

### Verification algorithm

1. First invoke D68 `inspectV4ReencryptionInventory` to validate every bucket, legacy logical shard-signature, per-record file/path HMAC, expected storage paths, collision safety and metadata shape. **No content reads on invalid metadata.**
2. Observe mutable source HEAD and insist it equals the pinned immutable 40-character commit SHA.
3. For every **live** record, call the existing production `V4StorageCodec.readToSink` with a discard-only sink (no staging writes):
   - **single:** fetch the exact opaque object, decrypt AES-GCM `content` AAD, verify complete plaintext size and SHA-256;
   - **chunked:** sequentially fetch/decrypt every `part` with its exact indexed AAD, incrementally hash plaintext and verify total size/digest; test uses an actual >8 MiB fixture within user's 100 MB maximum;
   - **pack:** fetch/decrypt packed AES-GCM archive with the correct `packId` AAD, locate the correct file ID, verify its plaintext SHA-256 and size. Shared pack references count as **one distinct remote object**, although the legacy reader re-fetches/re-decrypts the pack per logical record.
4. Fail on missing, malformed, corrupted, truncated, auth-rejected, or hash/size-mismatched bytes. Wrap platform-dependent AES-GCM failure in a generic error without plaintext path in the primary error. Preserve abort semantics.
5. Re-observe source HEAD after all reads and refuse success if changed or unobservable. Cross-check actual verified counts, bytes and distinct object paths with D68 inventory.
6. On verified success, return a frozen, path-free result: `integrityScope: "all-live-objects"`, pinned SHA, live file count, distinct remote object count, total plaintext bytes as a BigInt decimal string.

### Important negative claims / release gating

- This function does **not** re-encrypt files, write backup archives, verify an independent backup, coordinate devices, fence concurrent writers, prevent an ABA ref race, prove no lost untracked local edits, migrate deletion history, test crash durability, or publish any destination commit.
- Re-reading the mutable branch HEAD before and after the operation detects most simple branch drift, **not concurrent change-and-revert (ABA)**; future Wizard needs a stronger coordinator and cutover/fencing policy.
- It verifies *referenced live logical content*, not all unreachable historic Git objects. Old ciphertext from Git history may remain accessible to holders of old keys.
- The reader currently uses production pack behavior, which may repeatedly decrypt a shared pack and allocate legacy pack buffers; larger scale and legacy compatibility need performance/resource review.
- The D66 `docs/release-gates/reencryption-wizard.json` **must remain blocked**. Passing D69 metadata/content tests does not mean completed Wizard or authorize publication.

## Verification evidence

RED: focused suite could not resolve missing `reencryption-content-verifier.ts`. GREEN: seven new focused tests cover real ciphertext round trip, missing/corrupt/truncated single objects, plaintext hash mismatch, pre/post-head races, refusing invalid inventories before any transfer, two records in one shared pack with ciphertext tampering, a real two-part AES-GCM file >8 MiB and corrupted later part, and cancellation. `pnpm build` maximum strict source build and full fast/resource/recovery/feasibility test suites pass; E2E bundle compilation and metadata/package checks pass. D69 performs no actual GitHub API live read or two-device migration.

The owner still needs to select destination A (isolated fresh history, recommended; choose new branch vs separate private repository) or B (in-place), before any migration writer, new encrypted branch, or cutover is implemented.
