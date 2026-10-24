# D77 — Make the fixed 8 MiB GitHub REST writer cap apply to ciphertext bytes

Date: 2026-10-24 (Asia/Bangkok). Based on clean/pushed D76 `fb2f9cbaa4dd2fff851d3698a2d8e7daabd6da53`.

## Actual defect

The encrypted V4 writer used `shouldWriteV4Parts(plaintextSize)` with the 8 MiB REST-safe **object** cap. V4 AES-GCM payloads include a fixed 33-byte header/nonce/tag overhead, so plaintext in `(8 MiB - 33, 8 MiB]` was incorrectly planned as one encrypted Git blob **larger than 8 MiB**. Existing `prepareParts()` likewise split plaintext in raw 8 MiB chunks and could emit encrypted parts 33 bytes over the same cap. This affected normal V4 Sync and new D76 orphan-branch transcode preparation. D76 had a deliberate fail-closed temporary rejection for the narrow single threshold; D77 replaces this with safe chunk selection.

## Contract and changes

- **One actual wire-object budget:** `V4_GITHUB_REST_SAFE_WRITER_BYTES = 8 * 1024 * 1024` remains unchanged. `maxV4NewWriterPlaintextBytes("encrypted")` returns `8 MiB - V4_ENCRYPTED_PAYLOAD_OVERHEAD_BYTES`; plaintext mode returns `8 MiB`. This is only a new **writer selection policy**; encrypted older V4 objects and legacy 48 MiB parts remain readable. No encrypted repository migration/config version change is needed.
- `shouldWriteV4Parts(logicalBytes, mode)` selects chunked when the **encrypted payload**, not the raw plaintext, exceeds the REST cap. The optional mode defaults to `plaintext` to preserve legacy test/source callers; all relevant production V4 encrypted call sites explicitly pass the current mode.
- `V4StorageCodec.prepare()`: same mode-aware single/chunked choice; `prepareParts()` splits at the actual safe *plaintext* part size, not raw 8 MiB.
- `V4StorageCodec.prepareFromSource()`: mode-aware part selection; clamps `partBytes` to the wire-safe plaintext size before computing objectCount, paths, and pulling source chunks. This retains compatibility with callers requesting an old 8 MiB part size while preventing a too-large encrypted blob. It remains lazy for virtual huge sources and uses the production per-part AES-GCM AAD.
- `sync-session.ts`: normal Sync uses mode-aware `shouldWriteV4Parts` and passes mode into `selectV4WriterPartBytes`. The latter subtracts AES-GCM overhead when calculating safe plaintext partBytes against the transport cap, preserving the mutation-operation budget and refusing unsafe combinations.
- `reencryption-stream-transcode.ts`: remove the narrow D76 near-8 MiB refusal. Re-encryption uses the **same shared** safe plaintext part budget as Sync and still demands successful full-stream `finalize()` before any record may be placed in a published index.

## Fail-first, acceptance, and scope

Fail-first `tests/v4/ciphertext-size-budget.test.ts` **4/4 RED** on the old code, then **4/4 GREEN** after the production fix. It compares encrypted/plaintext classification at boundary minus/at/plus one, validates whole-buffer and streamed encryption/decryption at the limit and above it, checks all encrypted blob bytes <=8 MiB, and validates transport/mutation headroom. D76 tests **8/8 GREEN** after replacing obsolete rejection with successful near-boundary re-encryption.

An additional **normal production-session integration regression** in `tests/v4/sync-session.test.ts` performs encrypted V4 Force Push at `8 MiB - 33 + 1` bytes using the actual V4SyncSession and an instrumented MemoryGitHub, asserting every Git blob is <=8 MiB and the resulting record is chunked. Scanning still performs an initial plaintext read for hashing if the file is below the 32 MiB whole-buffer ceiling; uploading ciphertext uses the bounded streamed path. The integration suite passed **94/94**. Existing `tests/resource/v4-chunk-upload.test.ts` previously expected virtual 5 GiB preparation to produce 107 parts based on legacy 48 MiB **reader** parts. The new REST writer intentionally produces **640 8 MiB parts** in plaintext mode; the fixture now checks the current writer budget and remains virtual (no physical multi-GiB file). Real file test data remained <=100 MB, as owner required.

Full strict TypeScript/esbuild, fast/resource/recovery/feasibility suites, GitHub E2E compile, metadata/package validations are required before commit. **No live GitHub branch or user vault data was changed for D77**; native Obsidian on Windows, macOS, Linux, Android and iOS still requires separate acceptance.

## Release/cutover boundary

The owner approved architecture A: new orphan-root branch in the **same** physical repository, with old source preserved for recovery and independent second-device validation before further cutover. **This writer-size change does not authorize publishing any migration**, resolve interrupted migration/backup/stale-device gaps, or weaken D66's first-release blocker. Gate stays `status: blocked`; only `ownerApprovedMigrationTopology: passed`, six other checks pending. Owner has not yet answered whether **all old-branch devices must pause Sync throughout migration and per-device cutover**. Do not choose that high-risk device policy by default.
