# D167 — Best-effort journaled Destination Blob Staging

Date: 2026-10-30. Status: internal testable implementation; first public release remains **blocked**.

## Scope

D166 allowed the same-repository frozen Backup ref to be created and reconciled via owner-accepted best-effort WAL readback on Windows Node, without pretending directory `fsync` succeeded. Previously, the approved three-branch Staging coordinator still invoked `assertCrashDurable()` before the one-shot Backup → Staging handoff and each Git Blob POST, which refuses with Windows directory `fsync EPERM`.

D167 adds `stageV4BestEffortJournaledThreeBranchVault()` as a **separate, explicit-risk-acknowledgement** internal entrypoint. It requires an already authenticated frozen Backup WAL observation and exact expected generation. The best-effort checkpoint uses the live WAL cooperative lease and D165's three filesystem checkpoint readbacks plus two authenticated AES-GCM journal reads pinned to the Source commit, Destination repository and expected WAL generation. The Staging engine has an explicitly named `assertBestEffortWalCheckpoint(generation)` callback; it cannot be confused with `assertCrashDurable()`. It accepts **exactly one** durability/checkpoint callback for approved three-branch staging; the default strict API retains its strict `fsync` behavior.

After exact verified Backup, the engine records a one-shot staging handoff before any immutable object request, and an authenticated Git Blob intent before every upload. Each pending intent and appended SHA-1/size receipt undergoes a generation-bound checkpoint; returned Git Blob identities must exactly match the independently calculated expected bytes. A failed checkpoint leaves the intent unresolved, prevents further upload and forbids silent new-run retry. An unknown GitHub Blob response remains pending; the caller must not automatically repeat it. Full ciphertext records and receipts are checked against the journal before a completed Staging report is returned. No Git ref, source branch, active device settings, secret or local index is changed by the new wrapper.

## Verification

The `reencryption-staging-receipts.test.ts` D167 regressions cover: complete new-key AES-GCM ciphertext readback and WAL receipts with no publication permission; explicit acknowledgement rejection with no writes; stale Backup generation refusal; simulated torn WAL immediately after Blob intent with zero uploads and no retry; ambiguous GitHub Blob outcome leaving one pending intent and no replay; disposable real Windows Node WAL staging, complete readback and repeated-run rejection. Existing D109 strict Windows `fsync EPERM` refusal and staging tests still pass.

Focused Staging, full Fast, Recovery, Feasibility, Resource, max-strict TypeScript, Production Build, release validators, GitHub E2E compile-only, and bounded 100 MB cryptographic soak were run as non-destructive local checks. No actual credentialed GitHub Blob POST or installed Obsidian migration was performed.

## Remaining release blockers

This new Staging route is not wired to the Wizard or a public migration controller. A complete new Destination still requires the verified orphan candidate/manifest, guarded Git ref publication, independently authenticated remote readback, local Settings/SecretStorage/Index Cutover, restart/Manual Recovery, and installed-device/real disposable GitHub qualification. The Backup and Source branches must remain intact. No physical power-loss guarantee is claimed. The release gate remains `blocked`, Wizard Preview-only; never use this pre-publication Staging proof to permit automatic Sync, local Cutover, old-key cleanup or Git ref creation.
