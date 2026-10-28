# D134 — Cross-platform Copy-on-Write Shadow Local Index and SecretStorage API boundary

Date: 2026-10-28. Strict crash-safe Re-encryption remains PREVIEW ONLY; release gate **BLOCKED**.

## Why this change

The normal V4 local index writer saves changed shard files in-place and writes a single final header. During a Re-encryption branch switch, an interrupted in-place write can produce mixed old/new shard generations; the existing reader invalidates such cache, but the initiator should preserve the known-good **old Source index** until a separately authenticated cutover transaction commits.

The new helper `src/lib/v4/reencryption-shadow-local-index.ts` prepares a **new run-scoped Destination index in a separate sibling directory**, never touching the old active root, settings, SecretStorage or GitHub. The helper intentionally returns `localCutoverAuthorized:false`, `resumeSyncAuthorized:false`, `oldPassphraseCleanupAuthorized:false` even after successful staged readback. No Wizard execution wiring or active local-index selection change exists.

## Safety and cross-platform contract

- Inputs require safe scoped paths, unique run ID, validated fresh encrypted Destination identity, exact Destination Git commit SHA, device ID, complete non-dirty candidate shard map, and **caller-provided initiator quiescence and strict crash-durability assertions**.
- Refuses an already-existing Shadow directory. A failed or lost acknowledgement, including an incomplete shard/header write, leaves that run-scoped folder intact for **manual recovery**, never silently overwrites it.
- A synchronous **per-adapter same-stage guard** blocks two overlapping callers in this JavaScript process from both passing a previously absent-root check. It is **not** an OS-wide process fence, so real adapters/installed testing must supply storage ownership and unsafe path alias protections.
- A defensive candidate copy is staged using the existing V4 sharded writer, then the entire staged index is read again. Require exact Repo ID, Device ID, Commit SHA, shard labels, SHA-256 per-shard content digests and full serialized records parity. A self-consistent forged replacement shard hash/digest does **not** establish expected content and is rejected by exact comparison.
- Caller-owned candidate, records, expected identity, run ID and active root are snapshotted before awaits and rechecked before writes and after readback; changed values fail closed.
- Even with passing callbacks, the staged result is **not** proof of power-loss durability or complete remote readback. Windows Node-only directory `fsync EPERM` is still unresolved. This is a safe **independent staging primitive**, not an atomic storage cutover or proof of no external edits.

## RED → GREEN and Windows evidence

- Added `tests/v4/reencryption-shadow-local-index.test.ts`: complete readback without active-index change, failure at shard/header writes, rejection of reusing stale shadow directories, refused/failed durability and lease gates, malicious content substitution with a newly recomputed self-consistent SHA-256, callback mutation of candidate, same-run overlapping caller guard, lost write acknowledgement, post-write candidate mutation, and invalid scope/candidate rejection. The substituted-shard and callback-mutation tests initially FAILED, passing only after exact content comparison, snapshots and concurrency checks.
- Added `tests/recovery/reencryption-shadow-local-index-windows.test.ts`: real disposable Windows filesystem under this worktree's ignored `.tmp`. Fails an on-disk shadow header write, verifies byte-for-byte that active index header and shards remain unchanged, checks a restart cannot reuse that shadow directory, then uses a distinct staging root to complete readback. It does **not** mutate the user's Vault.
- Latest stable-source validation on real Windows x64 / Node v24.22.1: targeted fast **9/9**, real Windows recovery **1/1**, full Fast **962/962**, new fresh repeat **10×962/962** (exit 0), full Recovery **83/83**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, Production Build, GitHub E2E compile-only (3 bundles), metadata/package checks and 100,000,000-byte bounded cryptographic Soak with matching reference SHA-256 ALL PASS. End-to-end live GitHub branch writes and physical power-cut testing are NOT part of this stage.

A separate [D134 shadow-index technical and fault-matrix record](d134-shadow-local-index-staging-2026-10-28.md) details the exact snapshot comparison, synchronous same-adapter claim and nine-case crash/concurrency tests.

## SecretStorage API clarification — no false deletion claim

The publicly exposed Obsidian SecretStorage API supports `getSecret(id)`, `setSecret(id, value)`, and `listSecrets()`; **it does not expose a `deleteSecret` or `removeSecret` method**. Official guide: https://docs.obsidian.md/plugins/guides/secret-storage ; published TypeScript API: https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts .

Thus the existing `setSecret(oldId, "")` pattern may **clear the accessible value**, but it cannot be described as guaranteed deletion of the Secret entry, secure erasure of disk blocks, deletion from backups, or removal from Obsidian's Secrets UI. The D133 owner decision remains: do NOT retain an accessible obsolete old passphrase **after independently proven durable cutover**. Source/Backup/history remain encrypted under the old key; the user receives a pre-confirmation warning to save their own copy. Whether to request actual removal of the now-empty Secret entry through Obsidian UI is a distinct UX/API decision. **No automatic SecretStorage changes** are implemented in D134.

## Remaining Production blockers

- Independently durable and authenticated local Cutover intent + commit receipt; atomic/reconcilable Settings, SecretStorage ID and Index selection across app crash/restart and power-loss.
- Cross-platform storage persistence contract (Windows parent/leaf directory `fsync EPERM`), physical installed Obsidian desktop/mobile evidence, mobile parity adapter, complete source/backup/destination GitHub live three-ref acceptance with pinned repository ID.
- No current authorization to publish refs, switch initiator settings, resume Sync from a mixed state or clear old passphrase. Release gate status remains `blocked`, no Native Helper integration, no GitHub Actions.
