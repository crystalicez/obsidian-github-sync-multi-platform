# D87 — Owner decisions for first Re-encryption Wizard (2026-10-26)

> **HISTORICAL, SUPERSEDED:** D90 (2026-10-26) explicitly replaced the fleet-wide old-device freeze/acknowledgement from D87 with an independent encrypted orphan-branch fork. The old branch remains independently writable; other clients may follow manually or stay on the old branch. D88 also approved verified same-repository backup as sufficient location. Follow [D90 final policy](d90-owner-independent-reencryption-fork-policy-2026-10-26.md) and the latest `HANDOFF-NEXT-SESSION.md`, not the superseded D87 choices below.

This records the **explicit responses** to the six proposed questions; newer decisions here supersede statements in D74–D86 handoffs that listed these choices as unresolved. Work based on clean/pushed D86 `32aeddfee5a167637889e3b6c8dedf832bfc2e0c` in isolated audit worktree `.worktrees/d87-owner-rekey-policy`.

## Accepted choices

| Question | Owner answer | Contract / implications |
| --- | --- | --- |
| 1. Old-branch devices Sync during migration | **A** | **Pause Sync on every device still configured for the old branch** during migration and until each is individually transferred. Do not design background reconciliation of concurrent writes as a fallback. |
| 2. Local note edits during migration | **A** | Pause note editing while the wizard is moving and independently verifying data. Do not assume a plugin can forcibly lock Obsidian edits from unrelated plugins/processes. Changes must trigger fail-closed revalidation. |
| 3. Backup location | **C** | Use a **separate backup branch inside the original GitHub repository** rather than an independent archive/provider. Retain original source branch for recovery. Backup branch creation/readback is NOT implemented/authorized merely by this decision. |
| 4. Backup passphrase | **Not applicable** | No new separately encrypted backup archive is selected, so **do not add a separate archive password prompt**. An old encrypted Git V4 branch still requires the original encryption passphrase/key to decrypt; no decryption bypass is implied. |
| 5. Desktop WAL | **A for now** | Continue **Node.js-only**. Do not start new native-helper integration or ship a native binary. D86's Windows directory-fsync `EPERM` and lack of proven power-loss durability must remain blockers; never silently relax durability requirements. |
| 6. Retain old branch | **A** | Preserve old branch until **explicit, deliberate user deletion**. No timer, second-device pass, or successful Wizard step may automatically delete it. Git object cleanup/history erasure must never be promised. |

## Important unresolved risk (do not overwrite owner choice)

**Choice 3 C is NOT an independent backup**. Two branches inside the same physical GitHub repository share repository deletion, ownership/credential compromise, inaccessible account and infrastructure failure risks. D84/D85 restore/readback proofs were designed to require actual independent storage evidence and always returned `independentStorageVerified:false`. The user selected in-repo branch backup, **but has not explicitly instructed us to weaken the first-release `safePreviewAndBackup` acceptance gate or to authorize a release without independent recovery.**

**Default action:** respect C as the desired backup topology while leaving `docs/release-gates/reencryption-wizard.json` **`status:"blocked"`** and `safePreviewAndBackup:"pending"`. Do not forge independent evidence, silently substitute a local archive, or force a secondary service. Separate release-acceptance discussion must occur before weakening any original independent-backup gate; never consider the checkbox passed from C alone.

**Old-device freeze is approved as policy, not yet implemented.** Offline, old-version or malicious clients cannot be remotely paused just because this plugin shows an alert. A reliable fence/quorum or explicit offline-device handling must be proven; if not, leave migration blocked rather than assume all devices are frozen. Similarly, a plugin does not control unrelated editors and OS processes; verify immutable source state before/after every high-risk stage. Avoid automatic branch writer/cutover until behavior is proven and native two-device acceptance is complete.

## Code and tests (nonauthorizing)

`src/lib/v4/reencryption-owner-decisions.ts` exports frozen `V4_OWNER_REENCRYPTION_DECISIONS` reflecting the six choices. `proposeV4SameRepositoryReencryptionBackupBranch` validates owner/repo/branch safety, **four matching numeric GitHub physical repo identity values**, pinned 40-digit source commit SHA, and distinct source/destination/backup/default refs; in particular it rejects a destination branch equal to the default branch, even when the source branch differs. It **does not invoke GitHub**. Returned frozen proposal always says `independentStorageVerified:false`, `actualBackupCreated:false`, `backupReadbackVerified:false`, `permissionToPublish:false`, `cutoverAuthorized:false`, `oldBranchDeletionAuthorized:false`.

This does not itself establish that a backup branch exists, that its Git tree points at the verified pinned source commit, or that the old devices have stopped. A future backup-ref implementation needs atomic collision-safe create, immutable commit/tree readback, branch-ref identity revalidation, and ambiguous API outcome reconciliation. Never produce a new backup ref on the user repository before the rest of the migration transaction/approval is designed.

`tests/v4/reencryption-owner-decisions.test.ts` covers policy exact choices, same-repo correct backup ref proposal, wrong refs, invalid SHA, wrong physical ID, and no implicit cutover/independent backup entitlement.

## Still pending

- Approve **how to handle old devices that are offline**, and prove the pause/read-only UX works without risking hidden writes; user has already selected policy A, so do not re-ask A/B.
- Agree on how the first-release backup safety acceptance can be met under C, or explicitly discuss whether to change that requirement with full loss-risk disclosure; no such waiver is assumed.
- Node.js durable WAL mechanism on Windows meeting the required power-loss guarantees; D86's `assertCrashDurable()` remains fail-closed.
- Full first-release Wizard staging/publish/cutover, verified source vs destination, installed physical second-Obsidian-device restore, mobile best-effort acceptance, old-key-history disclosure.

No native binaries, GitHub Actions, force push, master merge, live migration ref, destructive old-branch operation or actual vault change in D87.
