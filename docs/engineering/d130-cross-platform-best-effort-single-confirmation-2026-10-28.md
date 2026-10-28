# D130 — Cross-platform best-effort re-encryption and one-confirmation automatic initiating-device cutover

Date: 2026-10-28. **Owner-approved intended UX and risk scope; implementation remains Preview-only, release BLOCKED.**

## Superseding owner decisions

After the D129 Windows process-isolation experiment, the owner chose **a common cross-platform experience** with **best-effort** Vault change detection and no undue native/helper complexity for the first release. The owner also confirmed that selecting and confirming Re-encryption at the **Review & Confirm** stage authorizes the **whole operation**, including automatic local cutover when migration is successfully verified; requiring another confirmation at Finish is unnecessary.

This D130 decision **supersedes any older D74–D129 statements that OS-wide non-cooperating Vault writer exclusion or an OS-specific Native Helper is mandatory to enter the initial production design**. D129's physical observation still stands: Node `wx+` sentinel plus `fs.open('r')` and repeated hashing cannot prevent independent external edits after the final inspection. This risk must be disclosed, not hidden behind a false lock/snapshot guarantee.

Crucially **best-effort does not waive any unrelated safety requirement**. WAL exactness, data integrity verification, immutable backup and source records, irreversible Git mutation discipline, crash-safe Branch/Passphrase/Local Index cutover, recovery from ambiguous partial work, and sufficient verified platform storage durability remain required before enabling execution. Windows Node-only parent/leaf directory `fsync EPERM` is still an unresolved **power-loss durability** problem, separate from the consciously accepted external-writer detection limitation. Do not mark the release gate passed merely because of this policy change.

## Intended common behavior on desktop and mobile

1. User explicitly enters the Wizard, verifies the old encrypted source, chooses a new orphan Destination branch and passphrase (with existing 600,000–1,200,000 PBKDF2 bounds), and reviews immutable Source / frozen Backup / new Destination, all in the same physical GitHub repository.
2. Exactly **one intentional confirmation** occurs at Review & Confirm, before any remote mutation or local cutover. This consent covers automatically switching the **initiating device** to the new Branch, Passphrase and Local Index after a wholly verified migration and crash-safe commit. No second prompt solely to approve a successful cutover.
3. Use best-effort source/Vault change checks with SHA-256, inventory, active Sync, open/unsaved editor and connection-snapshot guards where capabilities exist. Do NOT claim an OS-wide write exclusion, trust only mtime/size, or silently discard detected edits. A non-cooperating external process may edit after the last check; report this residual risk to the user before confirmation. Do not silently assume current Desktop-only implementation automatically works on Mobile.
4. Source stays independently syncable from old clients. Backup is a distinct frozen ref pinned to the old source snapshot SHA. Destination is zero-parent orphan with newly encrypted content, not a shared-history clone. Other devices remain on old Source until their users **manually** change Branch/Passphrase. No fleet-wide pause, cross-branch merging, automatic branch deletion or GitHub Actions.
5. If any prerequisite fails, the migration must stay fail-closed: no premature local branch/key/index settings switch, no false success, no blind Git mutation retry, and retain WAL/backup/ref evidence for a safe user-visible recovery process. The automated post-verification cutover MUST be crash-safe; consent alone is not sufficient authority to invoke the unfinished cutover engine.

## D130 code/UX changes (safe read-only only)

`src/lib/v4/reencryption-wizard-plan.ts` now returns explicit frozen, secret-free policy data with `initiatorVaultChangeDetection: 'cross-platform-best-effort'`, `externalWritesPrevented:false`, `userConfirmation:'once-before-execution'`, and `initiatorCutover:'automatic-after-verified-crash-safe-completion'`. These fields declare **intended behavior**, not proof that execution is ready. Existing `actualBackupCreated:false`, `actualDestinationCreated:false`, `publicationAuthorized:false`, and `localCutoverAuthorized:false` remain unchanged.

`src/views/reencryption-wizard.ts` displays a plain-language Best-effort/external-writes warning during preflight/review and explicitly states the planned single confirmation and **automatic, crash-safe initiating-device finish**. Run and Finish remain read-only blocked previews; there is no new GitHub write, Vault edit, second confirmation button, or settings mutation. No platform-specific native helper is shipped or required by the policy.

RED→GREEN tests in `tests/v4/reencryption-wizard-plan.test.ts` and `tests/v4/reencryption-wizard-ui.test.ts` first failed with missing fields/UI text and then passed after implementation. Both continue to prove that a proposal is immutable, contains no passphrase or token, and cannot authorize Git publication or local cutover.

## Remaining release gates / work order

1. Cross-platform capability parity: mobile read-only Vault inventory/streaming hash and unsaved-editor/active-sync validation suitable for best-effort, with explicit unsupported-capability fail-closed behavior. Existing physical Windows Desktop reader alone is not sufficient evidence.
2. Crash-safe, durable **initiating-device** local Branch/Passphrase/Index transaction and restart reconciliation, including cancellation/process termination/storage failures. Avoid changing architecture, persistent secret policy or recovery semantics without owner review.
3. Join the already tested Backup, Staging, Orphan Git publish, Destination readback, restore rehearsal and WAL proof components into a **single deliberately confirmed Wizard execution path** with per-phase progress, strong identity checks, interruption recovery and exact-source provenance.
4. Qualify storage durability, including the unresolved Windows Node-only directory `fsync EPERM`; explicitly research possible cross-platform recovery strategies, do not silently treat unsupported fsync as a successful sync.
5. Pin the numeric test-repository ID with the owner before real same-repo three-ref GitHub E2E; run installed Obsidian two-device Windows and Android/iOS acceptance plus macOS/Linux scope/feasibility evidence, history/old-key disclosure review. No GitHub Actions or remote tests without authorization.

`docs/release-gates/reencryption-wizard.json` must remain `status:'blocked'` while these proof obligations remain pending.

Historical D91 approval of the 3-branch design and D90 independent Source fork still governs the topology. This D130 addendum refines **concurrency expectations and confirmation/cutover UX only**.
