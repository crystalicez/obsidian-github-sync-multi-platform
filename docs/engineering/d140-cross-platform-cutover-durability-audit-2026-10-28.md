# D140 — Cross-platform durability capability inventory and no-authority gate

Date: 2026-10-28. **No release-gate promotion.** Strict owner-approved crash-safe re-encryption policy unchanged.

## What the production code actually exposes

The initiating-device local cutover would need to persist and reconcile **multiple independent local surfaces**, not merely the encrypted Git commit. The following are verified *implementation facts*, not promises about the operating system:

| Surface | Current implementation and observable durability | Still missing for strict cutover |
|---|---|---|
| Encrypted WAL journal and directory parents | `reencryption-desktop-wal.ts` writes a temporary file, `FileHandle.sync()`, rename, then attempts Node directory sync; invalidates earlier proof on every write. D86 tests fail closed on Windows directory-sync errors | A **real, verified** directory-entry + parent persistence guarantee after power loss; Windows Node sync reports unsupported in D140 disposable probe |
| Staged Shadow Index | `local-index.ts` sharded `write()`/readback, D134 Shadow verification, D137 remote authenticated content binding | Data/metadata/parent directory persistence and immutable authoritative selector after power loss |
| Active selected Index | `loadV4LocalIndex()/saveV4LocalIndex()` store independent index header and sharded cache | Atomic or journal-recoverable *selection* (not just copy of a header); demonstrated crash windows during D139 |
| Obsidian plugin Settings | `main.ts` uses `Plugin.saveData()` via `persistData()`; an exception triggers `loadData()` readback | No API-level physical fsync/transaction barrier in the current plugin code; readback/fulfilled Promise are **not** power-loss proof |
| SecretStorage | `SecretStorageLike` has synchronous `getSecret()/setSecret()`; settings hold a SecretStorage ID | No synchronized durable persistence barrier across SecretStorage and plugin data. New ID must remain readable; old value must survive until separately proven commit and cleanup |
| Local writer exclusion | Desktop WAL uses an exclusive lock file with inode/token checks and adapter I/O draining; D129 proves Node sentinel cannot block an uncooperative external Vault writer | A genuine cutover writer scope held across every surface (not a caller callback alone); avoid silently extending best-effort external edit detection into a false OS fence |
| Commit receipt and restart | D135 Intent phase is **prepared-uncommitted**. D136/137/138/139 only return observations | Authenticated, unambiguously durable **committed** receipt and deterministic, idempotent recovery for every crash position; not implemented |
| GitHub topology acceptance | D83 verifies exact Destination contents; D138 binds encrypted WAL manifest and Source/Backup/Destination receipts | Live final Backup+Destination revalidation and end-to-end three-ref acceptance before an actual local switch |

## Cross-platform state

| Platform | Current local evidence | State |
|---|---|---|
| Windows Desktop / Node | Real disposable D140 test successfully syncs a regular file but Node directory open/sync reports **unsupported**; prior D86 reports EPERM for directory durability | **Blocked** for strict power-loss-safe WAL/cutover |
| macOS Desktop | Source uses Node-backed desktop WAL, but no native macOS power-loss/reboot qualification was executed here | Unqualified; **blocked** |
| Linux Desktop | Same Node architecture, no physical filesystem/mount qualification here | Unqualified; **blocked** |
| Android / Obsidian mobile | Best-effort runtime storage and OS lifecycle, no independently proven cross-surface durability barrier or physical device qualification | Unqualified; **blocked** |
| iOS / Obsidian mobile | Best-effort runtime storage and OS lifecycle, no independently proven cross-surface durability barrier or physical device qualification | Unqualified; **blocked** |

This is a **capability audit**, not a claim that directory fsync is impossible on all Windows versions or all filesystems. Successful directory sync alone cannot establish that Obsidian `saveData()` or SecretStorage writes are durable.

## Implemented D140 diagnostic boundary

`src/lib/v4/reencryption-cutover-durability-readiness.ts` exports `assessV4ReencryptionCutoverDurability()` and eight ordered surface requirements. Inputs are **untrusted diagnostic claims** tagged with platform and evidence level: `unverified`, `process-restart-only`, or `claimed-power-loss-qualification`. The assessor rejects unknown platforms, foreign-platform proofs, duplicate surfaces, malformed labels and invalid levels; it never treats a submitted claim as an independently authenticated attestation. Even when every requirement is claimed power-loss-qualified, the state is `all-proofs-claimed-but-not-authenticated`, **never** ready/authorized.

Every outcome has `localCutoverAuthorized:false`, `resumeSyncAuthorized:false`, `rollbackAuthorized:false`, `remoteWritesAuthorized:false`, `oldPassphraseCleanupAuthorized:false`. The helper cannot write Settings, SecretStorage, local Index, WAL, GitHub, Vault or release gate; it is deliberately **not wired to production Wizard/Sync**.

Tests: `tests/v4/reencryption-cutover-durability-readiness.test.ts` exhaustively executes **5 × 3^8 = 32,805** full capability vectors over five platform labels; the report always forbids cutover and cleanup. It also tests zero/missing claims, malformed/duplicate/unscoped claims, mutation of input after assessment and the real `V4RekeyWalDirectorySyncProof` fail-closed invalidation after rename/EPERM. `tests/recovery/reencryption-cutover-platform-windows.test.ts` probes Node real directory-sync on a **disposable** Windows directory and explicitly cannot qualify actual OS power loss.

## Transaction design alternatives requiring later owner review

**Option A — keep D135–D140 as safe preview, investigate Node-only/Obsidian-supported capabilities, do not enable live cutover:** No additional native deployment dependency or weakened durability claim. Cannot ship functional strict re-encryption until platform evidence and complete local commit design exist. **Recommended and retained for now.**

**Option B — PoC a minimal platform persistence bridge in an isolated audit worktree:** Could eventually prove more precise filesystem persistence/atomic naming on desktop, but introduces native distribution/maintenance/security and still does not automatically solve Obsidian Settings + SecretStorage cross-store atomicity, Android/iOS lifecycle or third-party Vault edits. Existing owner authorization is limited to investigation/PoC; **do not include a binary or change release architecture without a fresh owner decision.**

**Option C — accept acknowledged `saveData()`/readback as if equivalent to power-loss commit and switch immediately:** Simpler but **violates owner-approved strict crash-safe re-encryption** and risks losing access after an interrupted settings/secret/index cutover. **Do not implement.**

A future design may prefer maintaining complete immutable Source and Shadow roots with a single authoritative selector and a durable commit receipt, rather than overwriting the Source index directly. But this is **only a design candidate**, not an approved architecture or an atomicity claim; the selector's persistence medium and recovery semantics must be separately proved.

No GitHub Actions, branch deletion, force push, migration to real user Vault, Native Helper promotion or release promotion was performed. **Verified test result:** D140 diagnostic focused **5/5**, all 32,805 evidence combinations, Windows physical disposable Node directory-sync probe **1/1**, full Fast **1011/1011**, exact-source 10-round repeat **10×1011/1011 PASS (exit 0, zero failures)**, Recovery **87/87**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, Production Build, GitHub E2E compile-only three bundles, metadata/package validations, and 100 MB reference SHA cryptographic soak PASS. Commit SHA and next-stage blockers are tracked in `HANDOFF-NEXT-SESSION.md`.
