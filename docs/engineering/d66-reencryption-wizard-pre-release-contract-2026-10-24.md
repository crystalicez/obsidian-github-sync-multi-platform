# D66 — Re-encryption Wizard: required first-release safety contract

Date: 2026-10-24 (Asia/Bangkok). User has **explicitly chosen**: the Re-encryption Wizard is required **before the first public release**, not a post-release feature. This document is a proposed architecture and a release-blocking contract, not approval for any destructive migration.

## Known V4 properties and non-negotiable invariants

- The PBKDF2-HMAC-SHA-256 default is 600,000 iterations, with accepted new-repository settings of 600,000–1,200,000. Remote untrusted values above 1,200,000 fail closed. An existing repository's authenticated remote configuration, including KDF salt and count, is authoritative.
- Keys are derived using the passphrase, remote KDF salt/iterations **and the repository identity** (owner/repo#branch). Content, encrypted logical paths, metadata, journal, packs, and parts can depend on the derived keys. Editing only `config.json`, or Force Push of files under a new key without a complete plan, is unsafe.
- A running sync owns a stable settings/GitHub connection/encryption snapshot. The wizard must serialize against new syncs and scheduled watchers, await cancellation boundaries, and prove no pending recovery WAL or conflicting local mutation before any cutover.
- No remote deletion, force-push, Git history rewrite, direct GitHub Actions, silent passphrase replacement, or branch switch is authorized by the user's current decision.
- Local test files stay <=100,000,000 bytes, REST part size stays 8 MiB, desktop tests use actual Windows Obsidian, and mobile background work remains best-effort.

## Critical architecture decision — NOT YET APPROVED

**Option A (recommended): snapshot to a distinct *empty* branch or repository**. Keep the old encrypted remote and exact head untouched, prepare a separate encrypted destination from an authenticated, fully enumerated and verified snapshot; the destination must have genuinely new commit ancestry, not inherit the old branch's Git tree/history. Commit only to a verified absent destination ref, verify a second device can decrypt it, and only then offer the operator a controlled cutover. Old clients must not silently continue syncing against the old branch. The old branch is kept as a recovery copy unless the owner explicitly authorizes subsequent removal. This is the safest non-destructive migration, but the historical ciphertext in the old repository and any existing clones/forks may still be available to holders of the previous key.

**Option B: re-encrypt on the same branch**. This preserves the current branch URL, but previous ciphertext blobs/commits remain in Git history even after a new tip is published, old clients may push against an incompatible era, and rollback/crash recovery and stale-ref fencing become substantially harder. It cannot be presented as erasing old data or immediately revoking old keys. A Git history rewrite is a distinct, highly destructive operation and is **not** an implicit part of Option B.

GitHub's official documentation on removing sensitive data explicitly warns that rewritten history can remain accessible in clones, forks, pull request refs and caches:
https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository

**Owner decision required:** whether migration creates a new empty destination (A) or is constrained to operate on the existing branch (B); for A, choose whether a new branch in the existing GitHub repository is sufficient or a different repository is needed when previous-key access must be revoked. No commit/ref mutation should be implemented until this is chosen.

## Proposed fail-closed Wizard phases (no destructive implementation yet)

1. **Inventory and identity:** explicitly display old source repository/branch, encrypted mode, exact remote HEAD, KDF iterations and salt fingerprint (never the raw passphrase), requested new PBKDF2 iterations, and proposed new destination; reject same destination, nonempty destination, wrong repo ID, unsupported topology, missing credentials or contradictory configuration.
2. **Freeze source snapshot:** warn to pause other devices; wait until local sync/watcher is quiescent. Read a pinned remote commit and validate config/head/shard hashes, storage paths, part/object integrity and data availability. Fail closed if remote HEAD or local relevant content diverges before a publication checkpoint. Ask whether to include local-only edits and unresolved conflicts; don't make that policy choice silently.
3. **Recovery and backup:** require a verified, user-accessible backup plus size/hash inventory, enough staging space, all necessary KDF material available, and zero ambiguous WAL/recovery state. Protect the old remote and local vault untouched. Avoid storing cleartext credentials/passphrases in durable logs, memory dumps, screenshots or release evidence.
4. **Copy and re-encrypt all reachable logical content:** produce fresh cryptographic salt and keys, new authenticated metadata, journals, opaque paths, packs/parts and ciphertext; explicitly preserve file semantics and deletion information as agreed. Keep memory bounded, multipart upload parts 8 MiB; never assume that merely changing config/KDF parameters rekeys old ciphertext.
5. **Publish to an isolated destination with exact-CAS and idempotent recovery:** preflight destination ref absent; upload immutable objects; never change the user's original branch. Verify candidate index/config/head consistency and remote commit identity before exposing a success state. Recover from interrupted upload without adopting a partial result.
6. **Second-device verification and cutover:** independently decrypt/restore and compare plaintext hashes/counts, Unicode paths, rename/delete/recreate and large multipart files. Once both new origin and second-device verification pass, offer an explicit, separately confirmed per-device switch; leave old branch read-only operationally (requires owner-selected coordination procedure).
7. **Failure handling:** any validation, timeout, permission, quota, CAS race, process death, or mobile background kill before validated cutover must not lose source data. No automatic destruction of old branch or restore point. Reopen/resume only with authenticated stage identity and exact source/destination evidence.

## Release acceptance contract

`docs/release-gates/reencryption-wizard.json` is tracked with `status: blocked` and seven pending checks. The local **stable release** entry point now reads this declaration, fails before any publication side effect if missing/malformed/incomplete, and allows `qualified` only when every check is `passed`. This is an *operator-reviewed acceptance declaration*, **not** a substitute for actual tests. The existing exact-SHA qualification and clean-master gates remain required, and the release path must not be invoked while blocked.

The status may only be advanced after:
- Owner formally approves destination topology and old-history/key-retention semantics.
- UI confirms threat-model limitations; passphrase/KDF iteration changes are validated and never applied to existing repo implicitly.
- Non-destructive preview/preflight works; backups and all-file integrity are independently verified.
- Automated RED→GREEN tests cover fail-closed cases: wrong old passphrase; unsupported/malformed remote; wrong repoId; too many iterations; missing/corrupted/duplicated objects; source advances after inventory; destination becomes nonempty; insufficient disk; quota; CAS loss; cancel/kill during each phase; ambiguous remote responses; WAL pending; staged secret leakage; stale second device.
- Real two-instance Obsidian + live GitHub runs on a random preflight-absent disposable destination and prove both new and old content, recovery and no unintended source mutation, with independent cleanup verification.
- Physical Android/iOS and desktop/platform compatibility tests cover the intended user-facing cutover and interruption policy; document any explicitly unsupported cases.
- Independent audit checks the old-key-history limitation (Git history cannot be promised as erased), any manual deletion operations and release gate evidence.

## Scope boundary

D66 implements only release blocking, tests and a design/acceptance contract. **No Re-encryption Wizard implementation, no key rotation, no native migration, no GitHub remote mutation, and no stable release.**
