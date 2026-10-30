# D179 — Fenced pre-commit readiness, still uncommitted

Date: 2026-10-30. Status: **read-only internal migration inspection**; Wizard **Preview-only**, release gate **blocked**.

## Problem and scope

D178 reauthenticated all Destination ciphertext and plaintext against local Shadow, current Source/Backup/Destination refs and an encrypted WAL. D176 authenticated the separately prepared AES-GCM selector and D138 independently checked local Source, Settings, SecretStorage, Intent, WAL candidate digest and remote Destination. A future Cutover cannot safely pick a good report from each independently timed check if the local identity, secret or source changed between them.

`src/lib/v4/reencryption-fenced-precommit-readiness.ts` adds the internal **read-only** `inspectV4FencedPrecommitReadinessAfterRestart()`. It requires an exact D142 Run/Index/Device/three Branch/Commit/Tree/Passphrase Secret ID identity; the same journal/WAL, plugin-private adapter, cooperative initiator lease, and actual Git client shared by all dependent readers. It pins read methods, source/destination secret *values*, all relevant settings, candidate, remote config, WAL generation, source and shadow serialized Index states, canonical D173 Fence and the AES-GCM journal key across asynchronous checks. It does not serialize the GitHub Client object (which may contain credentials or circular internal state); only the pinned repository/config/receipt fields are compared.

Inside **one** exclusive caller-supplied cooperative lease, in this order:

1. Check Fence and capture Source/Shadow/healthy WAL state.
2. Read and authenticate D176 prepared Selector, D170 Intent, Source Settings, old/new Secret IDs and best-effort WAL; active `selector.json` must remain absent.
3. Verify full Destination Git Tree/Blob, encrypted HEAD/shards, SHA-256 of every plaintext file, bound to immutable Shadow via D178 (which also checks live three Branch refs twice).
4. Rerun the independent D138 candidate-manifest digest, Source/Settings/SecretStorage, Intent, WAL, Shadow and complete Git verification using the **same lease**.
5. Recheck D176 prepared Selector/Fence, Source/Shadow/WAL and pinned secret/settings/reader identities. Anything mismatched is `manual-recovery-required` without performing a write.

Nested verification calls receive a checked *borrowed* lease callback, never an attempt to reacquire a nonreentrant OS lock. The successful report is `all-prepared-surfaces-coherent-uncommitted`, with `completeDestinationContentReverified: true` and **all** `localCutoverAuthorized`, `resumeSyncAuthorized`, `rollbackAuthorized`, `remoteWritesAuthorized`, `oldPassphraseCleanupAuthorized` permanently **false**.

**Critical limitations:** The D138 strict read-only checkpoint is supplied an owner-approved Windows **best-effort authenticated WAL readback**, *not* physical directory fsync or power-loss durability. The check is purely preparatory and is **not** an authoritative committed Selector, atomic Settings/SecretStorage/active-Index switch, remote cross-process lock, second-device acceptance, or a guarantee that a noncooperating writer cannot make a transient remote ABA change. Backup Source ref/Commit/Tree is freshly inspected, not every Backup encrypted content blob. The installed Wizard does not invoke this API.

## Regression evidence

Four D179 scenarios added to `tests/v4/reencryption-destination-exact-commit.test.ts` with real AES-GCM-encrypted Unicode, empty and chunked >8 MiB Destination content, authentic local Shadow, D170 Intent, D173 Fence and D176 AES-GCM Prepared Selector. They cover: full successful read-only composition under **one holder acquisition** with no extra writes, preserving Source/Secrets/Index and no `selector.json`; independent torn Intent, stale Source Settings, changed new key, tampered prepared Selector, WAL generation, wrong candidate, missing/torn Fence; a new key secret changed during Git blob read; and Source Index changed during Git scan, rejecting proof and leaving only the test-initiated Source edit. Previous D83, D137, D138, D143, D172, D176–D178 regression remains green.

**Full Fast: 1173/1173 PASS.** Maximum Strict TypeScript, Production Build, Recovery, Feasibility, Resource **11/11**, GitHub E2E compile-only **3 bundles**, metadata/package validators and exactly **100,000,000-byte** bounded SHA-256 cryptographic soak all PASS. All integration reads used mocked GitHub clients with real cryptographic contents; no credentialed GitHub migration, installed Obsidian Desktop/Mobile cutover or physical power-cut E2E was performed.

## Next release blockers

Do **not** infer any commit authorization from a complete D179 read-only report. The next difficult architecture/policy boundaries are a separately authenticated **committed** Selector+Receipt, best-effort ordered Settings/SecretStorage/Active Index transaction with restart/manual recovery, cross-process/multi-device writer constraints and actual installed Obsidian Desktop/Mobile acceptance. Ask the owner before enabling any irreversible real-user cutover or automatic unarm/cleanup. Keep Source, Backup, old passphrase and Git history. No Native Helper, GitHub Actions, release, merge or Wizard Run. `docs/release-gates/reencryption-wizard.json` remains `blocked`.
