# D101–D103 — Encrypted 3-branch ref-intent WAL and read-only interrupted publication reconciliation

Date: 2026-10-27. Status: **internal implementation with offline + actual Windows filesystem readback evidence; release remains BLOCKED**.

## Owner decisions remain binding

D90–D91: old/source stays independently writable on other devices, initiator makes a copy/fork to a new **zero-parent encrypted destination Git branch**, after a separate **same-repository pinned old-key backup ref** is fully verified and scratch-restored. No global client pause, automatic old-branch merge/delete or fleet cutover. User-chosen Node.js-only desktop WAL, no Native Helper without new owner decision, no GitHub Actions. **Windows directory fsync EPERM and initiating-device local index/key/branch cutover remain unresolved.**

## D101 — The existing encrypted two-slot WAL now records Git REF INTENT

Extended `src/lib/v4/reencryption-recovery-journal.ts` rather than adding an incompatible plaintext metadata file. Its original bounded AES-GCM / authenticated run source SHA / destination repo ID / generation slots now support optional encrypted `refIntents` and `refReceipts` collections.

- Each exact role (`backup`, `destination`) is unique per run and cryptographically bound inside the slot to a full 40-hex target commit and full root Git-tree SHA, plus exact same-physical-repository branch ID. Backup ref must point at the pinned old SHA. Destination must use the designated new branch and a different new commit. Both require safe GitHub coordinates/ref name.
- `recordRefIntent` persists the encrypted create-only mutation intent **before the first HTTP POST**; `markRefReadbackObserved` records only an independently verified ref observation. Both use strict generation CAS and the two-slot write/readback/locked adapter. A pending ref blocks further upload/another ref creation, a verified Backup ref is required before destination intent, and unresolved uploads block destination publication. Nothing grants permission to publish or cut over.
- `load` always says `requiresRemoteRevalidation:true` and permits read-only forensic inspection. New `assertHealthySnapshot(expectedGeneration)` refuses to authorize Git writes if **either slot** is damaged, missing after the first generation, or a generation changed; the previous reader could return an older valid slot even if the sibling was corrupt. Existing older journals with no ref fields remain readable as empty-ref recovery evidence.
- Existing WAL header intentionally contains destination Repo ID and original source Git commit SHA as stable run identifiers; new ref-role data and backup tree metadata live inside the encrypted slot. This is not a stealth claim that the entire WAL header is secret.

## D102 — Journal-bound create and publisher

New `src/lib/v4/reencryption-ref-journal-coordinator.ts`:

- `createV4JournaledFrozenBackup` records Backup ref intent in the **same WAL** before D99 create-only + independently verified complete old-key Backup contents. It binds exclusive lock and `assertCrashDurable()` checks before/after intent and at the POST boundary, and records verified observation only after D99 full readback.
- `publishV4JournaledThreeBranchDestination` requires verified Backup observation and **every exact staged ciphertext object receipt** persisted in the same WAL, plus D100's separate full Backup/Scratch/Source/Destination evidence, edit-guard, original Backup ref checks, original/source-independent Sync policy and actual zero-parent orphan commitment. Exact Destination intent must be persisted and the WAL healthy before D98 sends its **single** create-only POST; full remote AES-GCM/SHA-256 readback is required before recording the destination observation. Never retries ambiguous mutations.
- `stageV4ReencryptionVaultObjectsWithJournal` can explicitly hand off a *fresh, exactly verified and unchanged* Backup-only journal state to staging instead of erroneously calling `begin()` again. The handoff now advances the encrypted WAL once via `recordStagingHandoff` **before the first possible blob upload**, including an empty Vault; an interrupted handoff cannot silently be replayed on restart. Handoff requires matching generation/source commit, exact Backup ref/tree, no existing/pending blob or ref mutation. All older/partial journals still fail closed. An explicit handoff is not proof of power-loss-safe run ownership.
- All these functions remain **INTERNAL**, not called by Settings/production Sync. The WAL's storage interface can be mocked in tests; only a real OS-backed, independently qualified durable writer and exclusive ownership can count toward release. Their reports never allow local cutover.

## D103 — Restart/ambiguous HTTP read-only reconciliation

- `reconcileV4PendingFrozenBackupWithJournal` accepts one exact pending Backup ref WAL intent, a separately authenticated original snapshot, an explicit trusted/recovered lock and source tree SHA. It uses the existing D95 GET-only inspector to reread/decrypt **all old-key files** from the exact frozen Backup branch, compares file totals/bytes, then records ref observation in the healthy encrypted WAL. Missing/moved/wrong-key Ref leaves intent pending. No Git POST is sent.
- `reconcileV4PendingOrphanWithJournal` likewise validates an exact pending Destination intent, a verified old Backup ref, **complete prior staged Blob receipts**, and a freshly reconstructed expected new-key manifest. D97 independently authenticates the exact zero-parent root tree, encrypted V4 metadata, EVERY ciphertext object and every plaintext hash with the new passphrase. It may only record the matched observation; never recreates or overwrites a Branch or changes local settings/index.
- A process crash can abandon the D86 `.exclusive.lock`. It must be investigated and reclaimed **manually** before running these explicit recovery entrypoints. No unsafe stale-lock stealing is added.
- Recovery evidence remains `permissionToPublish:false` and `cutoverAuthorized:false`. A matching Ref does not prove this process created it, independent physical backup, local Vault stability, filesystem power-loss durability or installed Obsidian restore.

## Qualification performed

- **Fast 857/857 PASS** (D101/D102/D103 test extensions), **Recovery 79/79**, **Resource 11/11**, **Feasibility 136/136**.
- `pnpm typecheck:max-strict`, `pnpm build`, `pnpm test:github-e2e:compile` (three bundles), `pnpm validate:package`, `pnpm validate:metadata` PASS.
- Tests include two-slot lost/corrupt writes, wrong SHA/tree/role/repository/generation, no duplicate mutation, exact Backup→Blob→Destination journal sequence, denial for missing receipt, Node Windows `fsync EPERM` failure, old-branch independent Sync, read-only restart recovery of both Branch refs after lost GitHub replies, wrong ref/content, multi-stage encrypted V4 remote roundtrips, no automatic cutover.
- Actual Node filesystem test on the Windows worktree **wrote encrypted Backup/Destination ref intents to real slot files**, released its exclusive lock, reacquired it and read all intended state back with no plaintext Backup ref/Tree data. That proves logical OS file readback after a process-like boundary, **NOT power-cut/directory-entry durability**.
- No live GitHub branch publication/test was attempted in this stage; the prior test E2E is still blocked in preflight by missing `GITHUB_E2E_EXPECTED_REPO_ID` in the private ignored test credential file, never disable the pin. No installed native two-device Obsidian or mobile migration was tested; user vault unmodified.

## Blocking next tasks — DO NOT mark Release Gate passed

1. Establish an OWNER-APPROVED **Node.js-only Windows WAL durability** scheme with real power-loss guarantees or retain hard failure when directory `fsync` produces `EPERM`; this stage does not silently relax durability, introduce a Native Helper or assume successful `readFile` means power-loss safe.
2. Integrate a trusted live Obsidian source and local-edit isolation, persisted new-key material safely, destination candidate metadata/tree/commit intent, restartable full coordinator; validate credentials and network identity across every boundary. On restart, reconstructed expected new-key records must be authenticated, not blindly accepted.
3. Crash-safe **initiating-device-only** branch/new-passphrase/index cutover with staged rollback and preservation of unsynced local notes. Other devices remain on old Source until manually changed.
4. Disposable real GitHub 3-branch E2E with pinned numeric repo identity and cleanup, installed Obsidian Windows two-device, macOS/Linux/mobile acceptance, simulated kill/rate-limit/network failures and 100 MB physical test-file limit. No GitHub Actions.

`docs/release-gates/reencryption-wizard.json` stays **`status:"blocked"`**. Settings remains **Preview wizard**, intentionally not a nonworking production action.
