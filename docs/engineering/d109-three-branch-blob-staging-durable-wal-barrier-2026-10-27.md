# D109 — Real WAL durability barrier before any three-branch Git Blob staging

Date: 2026-10-27. **Internal engineering hardening; Re-encryption release gate remains BLOCKED.**

## Finding

D101–D108 ensured Backup/Destination branch create-only intents were tied to the same encrypted journal and real OS-held lease. The D81 new-ciphertext Blob staging path wrote each immutable Git Blob intent before its remote upload, but **did not require a successful crash-durability assertion** after the recorded intent. Merely re-reading a WAL slot cannot prove persistence across an actual power loss. That exposed a gap: a Git Blob might be uploaded after the journal intent had been accepted in memory but **before the underlying filesystem durability contract was verified**.

The historical D81 staging-only experiment is a separate, non-publishing proof path. The owner-approved D90/D91 three-branch path is stricter.

## Implementation

- **`src/lib/v4/reencryption-journaled-staging.ts`** now requires an `assertCrashDurable` callback whenever the stage operation uses `beginAfterVerifiedBackup`. The 3-branch path fails immediately if it is absent, even before the one-shot phase handoff.
- The stage operation checks the exclusive lease and WAL durability before entering phase handoff, after committing the one-shot `recordStagingHandoff`, **after each exact encrypted `recordUploadIntent` and before the first remote Blob call**, and after committing each confirmed receipt. The intent additionally passes `assertHealthySnapshot` so a damaged/torn/replayed sibling slot cannot become authorization for Git upload.
- The 3-branch `stageV4ReencryptionVaultObjectsWithJournal` result requires one final WAL durable barrier and whole-manifest consistency check. On a failed durability barrier, the function throws, does not send the next Git POST, and never automatically retries or clears a pending intent. A previously reached remote Blob could remain unreachable until explicit manual reconciliation; neither a Blob nor its WAL receipt authorizes local cutover.
- **`src/lib/v4/reencryption-ref-journal-coordinator.ts`** adds `stageV4JournaledThreeBranchVault`, which binds the same live `wal.assertExclusiveStageLease()` and `wal.assertCrashDurable()` capability used by Backup/Destination to the approved one-shot Backup→Staging transition, rather than asking an independent caller to supply an arbitrary stage-level callback. This remains internal and does not create a live Settings Wizard.

## Tests and qualification

- Added D109 regression tests for missing WAL durability callback, Windows `fsync EPERM` before phase handoff, failure immediately **after Blob intent but before Git POST**, refusal to replay an interrupted stage, approved coordinator's valid mock WAL path, and coordinator's guard failure. Focused Staging **21/21 PASS**.
- Added a disposable **real Windows Node filesystem** test using `acquireV4DesktopRekeyWalStorage`, the actual encrypted WAL adapter and the same stage coordinator. The test verifies that a real unsupported OS durability barrier blocks staging without an upload; on systems where the barrier succeeds it validates only the in-memory Git Blob fixture, not a real GitHub write or power-loss guarantee.
- Full local qualification: Fast **888/888**, Recovery **79/79**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, production build, GitHub E2E compile-only (three bundles), package and metadata checks **all PASS**.

## Explicit scope and hard blockers

- No user vault files, source/backup/destination Git refs or active settings were touched; real GitHub E2E and installed Obsidian two-device migration were NOT run. No GitHub Actions. Tests respect the 100 MB maximum physical file cap.
- The external WAL binding remains a **typed structural boundary**, not a cryptographically proven device identity. Test doubles return success by design. The real D86 Node-only Windows directory `fsync` problem (`EPERM`) continues to block migration when unsupported; do not replace the barrier with a no-op, downgrade durability guarantees or silently introduce an unapproved Native Helper.
- A trusted full process coordinator is still needed to pin source/backup/destination immutable manifests and credentials, ensure exclusive migration ownership, conduct actual installed restore, protect unsynced local changes, durably switch **only the initiating device's** Branch/Passphrase/Index and recover interrupted cutovers without touching independently syncing old Source clients.
- Live GitHub three-branch tests require the exact numeric disposable-repo safety pin `GITHUB_E2E_EXPECTED_REPO_ID`, which must not be fabricated or bypassed. The release-gate file stays `status:"blocked"` and the Wizard stays Preview-only.

Owner decisions remain D90/D91: independently writable old Source branch, frozen old-key same-repository Backup, new zero-parent encrypted orphan Destination, no automatic other-device updates, branch cleanup or cross-branch merge.
