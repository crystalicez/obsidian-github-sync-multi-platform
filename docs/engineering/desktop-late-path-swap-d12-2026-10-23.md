# Stage D12 — late Desktop junction path swap guard

Date: 2026-10-23. Isolated audit branch only, not a release approval.

## Fail-first physical Windows evidence

The earlier asynchronous `assertRecoveryPaths` can complete before a second
process changes a directory entry. A deterministic filesystem test uses the
existing synchronous `assertNoOpenEditor` interleaving hook to rename the
vault's `notes` directory, then install a junction to a disposable directory
outside the vault. These tests use actual NTFS junctions and Node `renameSync`,
not an in-memory filesystem.

- **Commit RED:** The original implementation completed `commitStage` after
  the late junction swap. The test failed with `Missing expected rejection`.
  Its unguarded `stage → target` rename could put the candidate outside the
  vault.
- **Rollback RED:** The original implementation altered the disposable
  outside file from `[42,43,44]` to the original-note bytes `[7,8,9]`
  during recovery. This is an observed outside-vault mutation, not just a
  theoretical path traversal.

Both regressions live in
`tests/v4/staged-desktop-io-containment.test.ts`. A host that cannot create
junctions/symlinks skips these cases; Windows in this run did execute them.

## Narrow hardening

`src/lib/v4/platform-io.ts` adds a synchronous metadata-only
`assertRecoveryPathsSync` check across relative stage, backup, residue and
target path components. It rejects a symlink/junction installed after the
asynchronous preflight, immediately after editor callbacks and before the
corresponding `renameSync` in Desktop commit and rollback. A failed safety
check preserves the original backup, stage or residue rather than restoring
through an untrusted path. No encryption, remote metadata, WAL schema, mobile
I/O or GitHub transport policy changes.

This is **not** atomic handle pinning. A separate OS process can still change
directory entries between `lstatSync` and `renameSync`, even without a
JavaScript await. A fully qualified no-follow, directory-handle-relative
solution remains a separate design decision requiring platform support.
Synchronous metadata operations also add renderer-thread latency, especially
on network filesystems. Do not claim those gaps closed.

## Verification

Physical containment regression **12/12 PASS**, including both D12 tests.
Production Build, Fast **498/498**, Recovery **79/79**, Fast Repeat
**10 rounds × 498**, Resource **11/11**, Feasibility **132/132**, bounded
100,000,000-byte virtual soak **1/1**, metadata and package validation PASS.
Three GitHub E2E bundles compiled only. No live GitHub write or native
Obsidian GUI run in this stage. No GitHub Actions, no `master` change, no
user vault, no physical test file over 100,000,000 bytes.

Release still blocked on OS-handle TOCTOU, slow/network filesystem latency,
real 1,000-note Obsidian lifecycle on this SHA, macOS/Linux/mobile, and
coordinated C2 protocol and merge UX qualification.
