# D134 — Independent run-scoped Shadow Local Index staging (strict crash-safe preparation only)

Date: 2026-10-28. **Production-safe isolated preparation primitive, not local cutover or permission to delete old credentials. Release remains BLOCKED.**

## Problem

The existing V4 local cache is a mutable sharded index: writing new shards in the same root before replacing the header can leave a **mixed-generation/invalid Source cache** after a process crash. While ordinary Sync can rebuild an invalid cache, a Re-encryption initiator cannot use such an in-place overwrite as an atomic Branch/Passphrase/Index cutover.

## Implementation

Added `src/lib/v4/reencryption-shadow-local-index.ts`, a pure TypeScript internal function `stageV4ReencryptionShadowLocalIndex`:

- Accept an **independently authenticated** Destination `V4LocalIndex`, exact Destination repo ID and Git Commit SHA, device ID, unique 8–128 character run ID, existing active root and caller-provided initiator/quiescence + strict crash-durable checks. Reject invalid, dirty, deleted, incomplete, wrong-commit or plaintext candidates before any write.
- Save to an **independent sibling root** `<activeRoot>-rekey-<runId>` instead of the active cache. Leave Source Index, Settings, SecretStorage, user Vault and GitHub untouched. It does not rename, swap, activate or delete either index.
- Reject any preexisting staging root; do not delete/reuse a possibly interrupted attempt. Claim a synchronous in-process guard against simultaneous staging of the same root on the same adapter. **The adapter still requires an external cross-process lease and safe persistent exclusive-claim semantics; this guard is not proof of physical OS exclusion.**
- Deep-copy each candidate record (including multipart path arrays) before the first await; the persisted local index does not mutate the caller's verified candidate. Compare the complete initial JSON view against the caller at quiescence and before reporting success, so mutation during awaited calls fails closed.
- After a strict platform crash-durability barrier, independently reload the staged header and **every shard** using the existing V4 checksum and size validation. Compare exact `repoId`, `deviceId`, `remoteCommitSha`, `formatVersion`, `epoch`, `generation`, `pathLayout`, mode, shard hashes, all record JSON and sealed content digests against the snapshotted candidate. This is stronger than trusting a self-consistent SHA-256 over attacker-substituted contents.
- Recheck durability and quiescence at the end. Return an immutable observation `status:'shadow-index-staged-uncommitted'` with `localCutoverAuthorized:false`, `resumeSyncAuthorized:false`, `oldPassphraseCleanupAuthorized:false`.

The function is **not wired into normal Sync or Re-encryption Wizard**. No live migration, physical SecretStorage mutation, branch publication, index promotion or automatic retry is authorized.

## RED→GREEN / failure matrix

`tests/v4/reencryption-shadow-local-index.test.ts` covers:

1. Healthy Source remains byte-for-byte unchanged while independent Destination shard/header round-trip succeeds; original caller candidate is unmodified.
2. Crash/fault at each staged write leaves Source readable, staging root suspect, and retry blocked.
3. Lost write acknowledgement **after** staged bytes were written blocks replay, rather than treating a rejection as proof no bytes persisted.
4. Incorrect or dirty candidate and invalid run/root/identity are rejected before any staged write.
5. Injected external lease failure, unsupported directory `fsync EPERM`, and broken staged readback fail closed.
6. Recomputed SHA-256 for a forged shard's *different* records cannot substitute for the exact original authenticated candidate. This case initially **FAILED before the strict record comparison**, then passed (RED→GREEN).
7. Mutating caller-owned candidate across `await` initially **FAILED before snapshot checking**; snapshotted deep copy + original identity comparison rejects it (RED→GREEN).
8. Two overlapping calls using the same adapter and root cannot both pass the synchronous cooperative staging claim.
9. Candidate mutation after the first staged shard write is detected before reporting a successful staging observation.

The nine fast-tier tests use bounded disposable **in-memory adapters** and callback fault injection. An additional **real Windows filesystem** recovery test in `tests/recovery/reencryption-shadow-local-index-windows.test.ts` uses a disposable `.tmp/d134-shadow-*` root, forces failure of the physical shadow header write, verifies the persisted Source header and shard are byte-for-byte unchanged, refuses reuse of the ambiguous shadow root, and confirms a *different* run-scoped root is separately readable. Its injected durability callback is intentionally a no-op, so even this physical test **does not certify power-loss durability**. None of these tests proves OS-level directory fencing, macOS/Linux/mobile behavior, or a full WAL cutover transaction. A successful mock `assertCrashDurable` is not hardware power-loss evidence.

## Final local validation

Latest exact-source Fast **962/962** and re-run repeat **10×962/962** (exit 0); Recovery **83/83**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, Production Build, GitHub E2E compile-only, metadata/package and SHA-matched 100,000,000-byte cryptographic Soak PASS. These are process-crash and injected-failure tests, not hardware power-loss evidence. Companion API finding: [D134 SecretStorage API clarification](d134-shadow-local-index-staging-and-secretstorage-api-2026-10-28.md).

## Remaining critical requirements

Strict platform storage persistence and Windows Node-only directory `fsync EPERM` remain unresolved. The next step is an authenticated, durable **local cutover intent/phase/commit** that binds a shadow index to verified GitHub refs and old/new Secret IDs and can reconcile every stopped state; it MUST NOT use ordinary `saveSettings()` as an atomic shortcut. Only after successful restart-safe completion may D133's cleanup policy clear the old local passphrase. The installed Obsidian multi-device and actual same-repository 3-ref GitHub acceptance remain pending. No GitHub Actions; no Native Helper release.

`docs/release-gates/reencryption-wizard.json` stays `status:'blocked'`.
