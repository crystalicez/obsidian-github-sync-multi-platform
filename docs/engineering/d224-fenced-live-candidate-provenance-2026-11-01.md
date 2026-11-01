# D224 — One-lease full remote provenance around production-namespace Candidate writes

Date: 2026-11-01. Status: **internal non-authorizing candidate staging, offline tests only**. First-public-release Re-encryption gate is still **blocked**.

## Failure mode addressed

D223 first introduced a real, distinct `cutover-*-candidate-uncommitted` AES-GCM Receipt/Selector pair and an isolated crash-window writer, but the writer only checked the **syntax** of a caller-supplied D142/D183 migration digest contract. It did not independently reprove that contract against Source Index, encrypted Destination Shadow, authenticated WAL, current complete GitHub Destination ciphertext and the original frozen Backup. A caller could supply a correctly shaped yet forged digest. Such candidate bytes must never become the basis of a committed Cutover.

D224 introduces `stageV4FencedLiveReencryptionCandidate` in `src/lib/v4/reencryption-fenced-live-candidate-stage.ts`, a **higher-trust composition** that accepts D179 precommit readiness, D216 frozen Backup verification capabilities and a fresh 128-bit transaction ID, **not** a caller-supplied contract.

## Precisely one exclusive cooperating initiator holder

The composer first verifies that all three inputs refer to the same immutable D142 old Source commit/tree, independent writable Source ref, frozen pinned Backup and new orphan Destination; that their WAL, journal, adapter, Secrets, holder and fence identity agree; and that the old/new passphrase values match the independently obtained storage readers. It pins all Git reader identities and methods, Git remote configuration and object identity, exact physical repository identity, old-key Backup branch, AbortSignals, WAL/adapter callbacks, stored Settings/Secrets, candidate, publication and transaction ID before the first await. A changed method, identity or cancellation even after the held callback returns fails closed.

One external initiating-device owner lease then encloses the entire sequence; each nested tool borrows this lease instead of independently acquiring/releasing it:

1. D216: freshly decrypt every encrypted Git blob in the **old-key frozen Backup** twice. Require pinned old Source commit/tree and matching old passphrase.
2. D183/D179/D178: independently derive the exact six historical Source Index, Destination Shadow, Prepared, WAL and Settings SHA-256 digests from full current new-key Destination Git reads and authenticated local state. No contract is accepted from the caller.
3. D223: write into the **isolated candidate root only**, in explicit `contract.json` → encrypted `receipt.json` → encrypted `selector.json` order, checkpointing/re-reading WAL/Sync Fence and AES-GCM after each critical boundary. A repeated invocation refuses any existing root, including partial artifacts.
4. D216 and D183 again **after** all candidate bytes have been saved; require frozen Backup contents, verified plaintext count/size, the exact same six digest contract and all prior pinned methods/identities to remain valid.
5. Read the authenticated WAL and exact Sync Fence once more before returning a non-authorizing candidate report.

If Git moves, a ciphertext fails authentication, WAL/Fence/Secrets change, an external callback is swapped, or persistence throws at any point, **no positive report is returned**. If candidate bytes were already written, all bytes and the active Sync Fence remain for manual investigation. There is no automatic retry or rollback. Old-key Source can independently advance while frozen Backup and new orphan Destination remain pinned under the approved three-branch topology.

This is still not an authoritative committed Receipt/Selector or the installed plugin runtime selection. A single cooperative holder cannot exclude non-cooperating OS writers, external GitHub clients or physical power loss; repeated Git readback cannot guarantee a state does not change **after** the final read. The reporter never permits local Cutover, Resume Sync, rollback, remote writes or deleting either passphrase.

## Tests

The new behavioral tests in `tests/v4/reencryption-destination-exact-commit.test.ts` use the existing authenticated D179/D183 current encrypted Destination fixture, **real D94 old-key Backup AES-GCM Git blob decoding**, and actual D223 adapter-backed staged candidate writes.

They prove:
- Complete old/new-key remote verification around the write, with one actual external holder and no changes to Source Settings/Index, SecretStorage, existing WAL or active Sync Fence; persisted candidate remains `authenticated-candidate-uncommitted` after independent Restart inspection.
- Changed Backup Git ref, damaged Backup ciphertext or missing old key refuses all writes.
- Backup Git ref, Destination Git ref or WAL generation changing just as the candidate Selector is persisted makes the attempt fail and leaves all candidate bytes for Manual Recovery.
- Malicious post-holder Backup Git method substitution cannot forge a successful stage report.
- An AbortSignal cancelled immediately after the complete held Git+disk proof cannot yield a positive stage result; the candidate bytes remain inert and Sync stays fenced.

Verification commands, pass counts and commit details are recorded at the top of `HANDOFF-NEXT-SESSION.md`.

## Remaining release work

**Critical**: This stage does not create an authoritative committed Receipt/Selector transaction. An installed-device production Commit must still prove its own verified preconditions and record a restart-safe, fail-closed best-effort commit point; then implement exact Source→Destination Settings/active Index/SecretStorage switching with Manual Recovery on torn transitions and stale-device protections. Native installed Obsidian Desktop/Android/iOS migrations must be tested before the release gate is passed. Never promote the isolated D223/D224 candidate Selector to the active runtime selector by copying or renaming it. D224 does not mutate GitHub, Settings, Vault or actual user credentials; it does not run GitHub Actions or cut a release.
