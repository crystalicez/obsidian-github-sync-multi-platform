# D132 — Cross-surface read-only WAL + local cutover restart evidence

Date: 2026-10-28. **Production-adjacent verification only. Strict Crash-safe policy retained; execution, restart auto-resume and release remain BLOCKED.**

## Scope and risk boundary

D131 already reads the possibly interrupted initiating-device Settings, SecretStorage IDs and V4 sharded Local Index and returns an observation that **never** authorizes Sync/cutover. However D131 did not inspect the separately authenticated encrypted Re-encryption WAL. A seemingly coherent Destination settings/index tuple is **not** proof of a committed migration, and an authenticated WAL can describe a partial or ambiguous GitHub ref write with no safe right to retry.

D132 introduces pure cross-platform TypeScript **read-only** src/lib/v4/reencryption-local-cutover-evidence.ts, composing:

- The existing V4ReencryptionRecoveryJournal.assertHealthySnapshot(expectedGeneration) authenticated WAL readback, requiring **both sibling slots healthy** as its implementation already enforces.
- A caller-supplied, real assertExclusiveInitiatorLease() and **strict** assertCrashDurable() (both required; never silently default to success).
- Exact SOURCE/Backup/Destination repo identities (three different branches in the same owner/repo), original Source SHA, exact Destination SHA, and the one expected WAL generation.
- All verified Backup and Destination ref receipts in the encrypted WAL, no unresolved pending Git/object intent, a staged candidate preparation and exact matching prepared candidate Commit/Tree/Manifest SHA, no unexpected publication or cutover authority.
- D131's read-only local settings/secret-ID/index inspector **between two independent WAL observations**, with lease/durability rechecks before the second WAL read.

The function snapshots identities/Secret IDs/device settings **by value before the first await** and rejects drift that occurs in an injected async durability/readback callback. No returned field contains secret values. The report is always one of:

- source-with-verified-remote-fork-uncommitted: WAL receipts are coherent and the initiating device appears to remain on Source. Does **not** authorize cutover or assume live remote refs are unchanged.
- destination-observed-without-local-commit: WAL receipts are coherent and local Settings/Index match Destination, **but no durable local Cutover commit proof exists**.
- manual-recovery-required: any contradictory/incomplete WAL or mixed/unverifiable local state, including changed references during the read sequence.

**Every report has** localCutoverAuthorized:false, resumeSyncAuthorized:false, rollbackAuthorized:false, remoteWritesAuthorized:false, credentialCleanupAuthorized:false. This helper does not persist a transaction, modify source/destination, write settings/index/secrets, delete a branch or clear old keys. It is not wired into the active Sync runtime or Wizard. The WAL asserts are provided by an injected implementation and are **not proven durable merely by a successful mock test**.

The D129 external-writer risk remains best-effort detection as approved by the owner; D131 strict power-loss Cutover/WAL durability **is not waived**. The D86 Windows Node-only parent/leaf directory fsync EPERM blocker is unchanged.

## RED→GREEN and fault-injection evidence

Eight new focused tests in tests/v4/reencryption-local-cutover-evidence.test.ts cover:

1. Authenticated-looking two-ref WAL and matching old device settings/index still **not committed**; zero write calls and zero plaintext credentials in output.
2. Matching new Branch/Secret ID/Local Index/commit remains **uncommitted**, never resume/cutover.
3. Missing, mutated or inconsistent Backup/Destination receipts, prepared candidate, generation, pending intents, publication flags all fail closed.
4. WAL contents changing **after** local index/SecretStorage inspection are detected via the second WAL readback.
5. Durability (EPERM), lease loss and journal-read errors refuse continuation without a permissive fallback.
6. A caller mutation of pinned **source Secret ID plus matching live Settings during the initial durability await** **FAILED before the fix** (falsely described the old Source evidence as coherent). The code now freezes the entire expected identity and starting settings before the first await, passes the pinned identity into the D131 reader, and detects any drift at return (RED→GREEN).
7. Invalid Source SHA, Destination SHA, reused Secret ID, unsafe index root, mixed owner/repo/branch, invalid generation and missing durability callback reject before any WAL/local storage probe.
8. A corrupted Local Index header makes otherwise coherent WAL receipts **manual-recovery-only**.

A complete WAL commit receipt, platform durability certification, authenticated remote reread, physical two-device validation and a safe storage-backed local Settings+SecretStorage+Index transaction remain **future necessary gates**. "Published ref receipt" in a local WAL is not evidence that a remote branch still points at that commit at the current instant. The new inspector MUST NOT be connected to an execution path as an authorization token.

## Full verification

Windows x64 / Node v24.22.1: focused D132 **8/8 PASS**; complete Fast **952/952**, Fast repeat **10×952/952** (exit 0, zero failures), Recovery **82/82** (including independent OS SIGKILL scenarios and external-process writer PoC), Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, Production Build, GitHub E2E compile-only (3 bundles), metadata/package validations PASS. Bounded crypto Soak **100,000,000 logical bytes / 12 chunks / 2 parts**, identical reference SHA-256 PASS. Neither live GitHub branch mutations nor installed Obsidian multi-device tests were run.

## Next safe work

- Design an independently durable **nonsecret** local Cutover intent/phase/commit record using the proven encrypted WAL and a certified cross-platform storage interface, without choosing a secret-retention or file-swap order until recovery cases are demonstrated.
- Prove the physical crash points of Obsidian saveData, SecretStorage and the V4 sharded Index, including ambiguous success/readback cases, with old/new credentials retained until safe.
- Resolve Windows Node-only directory fsync EPERM or obtain an explicitly proved equivalent persistence strategy — strict mode does **not** permit substituting process-only recovery for real power-loss guarantees.
- Integrate an intentional one-confirmation Wizard run only after source/backup/destination staging, restore and all local transaction readiness gates pass.
- Carry out numeric-pinned **live** same-repo three-ref GitHub acceptance and installed Windows/macOS/Linux/Android/iOS multi-device tests separately. No live remote mutations, GitHub Actions, Native Helper integration or release waiver in D132.

docs/release-gates/reencryption-wizard.json remains status: blocked.
