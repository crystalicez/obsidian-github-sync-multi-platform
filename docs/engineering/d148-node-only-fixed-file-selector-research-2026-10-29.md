# D148 — Node.js-only fixed-file selector storage research (Option A)

Date: 2026-10-29. **Owner chose A:** keep Node.js primary and Re-encryption **strictly crash-safe**. No Native Helper architecture promotion, no GitHub Actions, no unauthorized production cutover. Preserve immutable Source Index, separate Shadow Index and the independent selector direction from D145–D147.

## Candidate mechanism and independent source

The established D86 desktop WAL uses temp file + file `sync()` + atomic rename + directory `sync()`. D147 measured Windows directory `sync()` refusing crash-durable confirmation after a rename and again on a fresh lease; do not downgrade that barrier.

An alternative Node primitive may avoid *transaction-time directory mutations*: provision two **fixed, pre-existing files**, then open an existing file with `O_RDWR | O_DSYNC`, overwrite only its contents and call `FileHandle.sync()`. The libuv filesystem API [documents](https://docs.libuv.org/en/v1.x/fs.html) that `UV_FS_O_DSYNC` maps to Windows `FILE_FLAG_WRITE_THROUGH`. This is about synchronous **file I/O**; it says nothing about whether new parent/slot directory entries were originally crash-durable or the whole Obsidian + Git stores committed atomically.

### Real, disposable Windows experiment

`tests/recovery/reencryption-selector-fixed-slots-node-only.test.ts` provisions two files in a fresh disposable `.tmp` directory. It seals an existing D146 AES-GCM Selector test vector with the V4 journal key; writes to an existing slot using Node `O_DSYNC` and `FileHandle.sync()`; verifies exact bytes via fresh handles and exact cryptographic validation. It tests wrong WAL generation, wrong key, truncated ciphertext, two divergent/ambiguous slots and both empty. **Any non-empty invalid or ambiguous slot returns manual-recovery-required** even when another valid older slot survives, rather than silently choosing a previous generation. This is a *test-local diagnostic*, not a production Selector writer, not a transaction coordinator and not a crash recovery authorization.

Observed on this Windows host: **O_DSYNC + file sync + fresh reopen succeeded** on fixed files, while opening a directory and calling `sync()` still fails with a supported unsupported-filesystem code. The test does not claim that the file survives sudden power loss or that this approach works on every filesystem.

## Unresolved blockers — why this is not production-ready

1. **Initial file/directory provisioning:** merely creating two slots and flushing their file contents does not establish a durable namespace entry. Windows Node-only directory `fsync` still refuses; reboot/readback is insufficient. Losing one or both slots after a power cut must fail closed, but losing the authoritative WAL before any external commit also needs a safe remote reconciliation story.
2. **Commit authority and torn writes:** unlike temp + rename, in-place truncation/overwrite can leave corrupted new bytes after a crash. The other slot may still contain an old valid generation; accepting it automatically is unsafe after an uncertain Settings/SecretStorage/remote transition. The test deliberately rejects all such cases without an independently durable monotonic journal/selector authority.
3. **External writer lock:** this experiment has no OS cross-process lease or Vault editor fence. The existing D86 lock proves only cooperating WAL writers, not Obsidian editors.
4. **Independent persistence stores:** no proven atomicity across Obsidian `saveData`, SecretStorage, Source/Shadow Index, GitHub refs or external devices. No actual installed-device restart or hardware power-loss qualification on Windows, macOS, Linux, Android or iOS.
5. **Filesystem semantics:** successful `O_DSYNC`, `FileHandle.sync()` and readback are observations on this one Windows host, not platform-wide power-loss guarantees (controller caches, filesystem and media need separate qualification).

**Next research:** investigate whether a Node-only pre-provisioning protocol can demonstrate durable namespace identity without native OS helper or an unsafe assumption; require physical power-loss tests, authenticated journal generation checks and explicit cross-store recovery before considering any selector writer for production. If strict crash-durability cannot be established on Windows by Node-only APIs, keep the Wizard blocked and ask the owner before changing architecture.

`docs/release-gates/reencryption-wizard.json` must remain `blocked`; the Wizard remains Preview-only. No Source/Shadow/Settings/WAL/SecretStorage/GitHub mutation happened in this stage.

## Verified D148 result

Windows Node v24: focused fixed-file probe **1/1 PASS**, full Recovery **91/91 PASS**, Fast **1054/1054 PASS**, isolated unchanged-source Fast Repeat **10×1054/1054 PASS** (exit 0), Feasibility **136/136**, Resource **11/11**, Maximum Strict TypeScript, Production Build, GitHub E2E compile-only **3 bundles**, metadata/package validation, bounded **100,000,000-byte** matching-reference SHA-256 crypto soak all PASS. After the repeat, the Windows recovery probe was adjusted to detect (rather than permanently assume) OS directory `fsync` capability and reran full Recovery **91/91 PASS**. No power cut, genuine power-loss persistence guarantee or installed Obsidian/GitHub acceptance was tested.
