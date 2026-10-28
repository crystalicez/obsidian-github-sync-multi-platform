# D141 — Local Cutover acknowledgement versus power-loss persistence: executable fault model

Date: 2026-10-28. **Release remains blocked; Re-encryption Wizard remains Preview-only.**

## Finding

The current D135 prepared Intent, D136/137/138 cross-surface observations and D139 read-only restart classification **do not produce an authenticated, crash-durable local committed receipt**. D140 found no proven atomic barrier spanning Obsidian Settings `saveData()`, SecretStorage, the active local Index, encrypted WAL and filesystem directory entries. A fulfilled write Promise or immediate readback cannot by itself prove that a power loss preserves that write; likewise a purported committed receipt cannot authenticate the destination after a restart.

The ordinary `src/main.ts` settings flow writes new secret values, saves settings, then best-effort clears old secret IDs after a successful setting write/readback. This flow is **not** an approved Re-encryption cutover transaction and must not be reused to clear the old passphrase for migration: it has no crash-safe cross-surface receipt. No production setting flow was modified in D141.

## D141 deliverable

New pure `src/lib/v4/reencryption-cutover-fault-model.ts` explores all **five conceptual writes** without calling any adapter, GitHub API, SecretStorage or Obsidian runtime:

1. Select Destination Git branch in saved Settings.
2. Select the new SecretStorage passphrase ID in saved Settings.
3. Select Destination active local Index.
4. Persist a **hypothetical and untrusted** `committed` receipt.
5. Clear the old accessible secret value.

The two Settings changes are conservatively *modeled as independent logical surface effects*, **not** a statement that the real `saveData()` always writes fields separately. A torn/unverified serialized settings record or a competing settings writer cannot yet be ruled out after a power loss. Similarly, the model treats each acknowledged write as possibly nonpersistent or persistent independent of other unproved writes. This is a **fault hypothesis** rather than empirical evidence that every subset is possible on every filesystem.

The model enumerates all **5! = 120** orderings and every crash boundary plus every survival subset at that boundary (**2^0+2^1+2^2+2^3+2^4+2^5 = 63** scenarios per ordering; **7,560** total). Each report classifies observed Settings selector, Index selector, receipt presence and secret availability. Hazards include:

- Settings branch and passphrase ID disagree.
- Settings and selected Index disagree.
- A purported committed receipt exists before the Destination selectors match.
- Destination Settings and Index appear to match but there is **still no independently authenticated local durable commit**.
- Old secret was cleared before such proof.
- Overwriting the active Index may destroy its original Source local cache even if the **remote** Source branch is retained.

The last distinction matters: the fault model only assumes remote Source/Backup Git refs are not among its five local writes; it **does not** claim that the original active Source Index on disk remains intact. Source immutable local root preservation and any single selector design must be separately chosen and proved.

**Every scenario hardcodes `localCutoverAuthorized:false`, `resumeSyncAuthorized:false`, `rollbackAuthorized:false`, `remoteWritesAuthorized:false`, `oldPassphraseCleanupAuthorized:false`.** No scenario declares a completed transaction. Neither a claimed receipt nor all five hypothetical writes surviving grants permissions.

## Tests and cross-check

New `tests/v4/reencryption-cutover-fault-model.test.ts` exhaustively verifies 7,560 scenarios, hazards and zero authorization; tests the specific `receipt-first`, `Settings-first`, `old-key-clear-first` and all-surviving subsets; rejects duplicate, missing and invented actions; verifies no secret material is returned. It also cross-checks **all 7,560 outcomes** against D139's independent `classifyV4ReencryptionLocalRecovery()`: even when a fake receipt is present, only Source/Source with both secrets and an externally assumed authenticated Source Intent/WAL can observe `source-prepared-uncommitted`; Destination/Destination remains `destination-observed-without-commit-proof`; mixed and missing-key states require manual recovery. D139 still grants **no** cutover or Sync.

All tests use a pure in-memory model. **No physical power-loss, hard power cut, native Obsidian `saveData()` durability or SecretStorage persistence was proven.** The model never changes an actual Vault, disk index, local user settings, GitHub branch or secret. D139 already has a separate real-Windows-file reopened-state test; D141 does not misrepresent that test as hardware durability evidence.

## What this proves, and what it cannot

The model gives a reproducible list of failure windows that any proposed platform-backed cutover protocol must eliminate, authenticate or deterministically reconcile. It provides **negative evidence** against trusting operation order alone; it is NOT a proof that any proposed algorithm can deliver atomicity on mobile/desktop.

A design to investigate (not approved): retain immutable Source and Shadow local roots, bind both to D138/D139 verified content, then use an independently crash-durable **single authoritative selector and authenticated committed receipt**. Verify that every restart can resolve Source/Source, Destination/Destination and mixed persisted surfaces without deleting the older working key. On the current APIs, the selector itself still lacks a demonstrated power-loss durability barrier spanning `saveData()` and SecretStorage, and Windows Node directory fsync is unsupported (`EPERM`). Do not silently substitute an in-memory or readback-only success flag.

A second design path could isolate desktop native durability research (previously permitted as PoC **only**) but would add binary distribution, native crash/fault injection, mobile equivalents and ongoing security maintenance; implementing it as a release dependency requires fresh owner approval. Lowering the crash-safe standard is **not an option under current owner policy**.

Next gated development: formally specify an authenticated transaction receipt and non-authorizing recovery validator with fault-injected **durable-state evidence**, and obtain actual storage/OS platform guarantees before enabling the commit transition, old-secret cleanup or automatic Sync. Revalidate all three Git refs at the eventual commit boundary, including Backup. No GitHub Actions or mutation of live/owner Vaults.

**Verification on D141 source:** focused **7/7** tests, all 7,560 hypothetical crash outcomes cross-checked against D139, full Fast **1018/1018**, exact-source repeated Fast **10 × 1018/1018 PASS (exit 0, zero failures)**, Recovery **87/87**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, Production Build, compile-only GitHub E2E 3 bundles, metadata/package validations and bounded 100 MB reference SHA-matched crypto soak PASS. No tests here certify real power-loss durability. Push identity is recorded in `HANDOFF-NEXT-SESSION.md`.
