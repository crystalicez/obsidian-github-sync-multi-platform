# D378 — Real GitHub Backup creation bound to best-effort encrypted WAL

Date: 2026-11-10. Status: **isolated live E2E PASS; first release remains BLOCKED**.

## Scope and safety boundary

The owner previously authorized real GitHub **writes only in the separately isolated
disposable test repository/branches**. The scenario uses repository
`diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform`
pinned to numeric GitHub ID **1284153873**. Each run generates a fresh
`obsidian-sync-e2e/local-*` Source and deterministic hashed Backup branch,
proves both absent twice before child mutation, and independently verifies
both absent twice after cleanup. Neither normal nor ambiguous scenario
touches the canonical plugin repository, a user Vault, default branches, or
a release tag.

The D378 test-only helper in `tests/github-e2e/v4-real-github-e2e.test.ts`
uses a fresh physical Windows test directory under `.tmp`, the **existing
production** `acquireV4DesktopRekeyWalStorage`,
`createV4ReencryptionRecoveryJournal`, and
`createV4BestEffortJournaledFrozenBackup`.
The coordinator persists the exact Git Backup intent in encrypted two-slot
WAL **before** the single create-only GitHub POST; the successful path checks
the entire pinned old-key Backup and records that independently observed
result in WAL. It closes and reopens the physical WAL storage with a new
journal instance, authenticates the exact generation, both slots and Backup
receipt, and checks that remote publication/Cutover authorization remains
false. The test intentionally uses a synthetic ephemeral WAL key and local
storage (not the installed Obsidian initiating-device identity/Settings).

## Live results

| Scenario | Test process | Result |
| --- | --- | --- |
| `node scripts/run-github-e2e-disposable.mjs wal-backup-encrypted` | `5158b2cb-6252-4f9e-a13e-73dcc3b250b1` | **PASS**, exit 0, 1/1 test, 7/7 encrypted files, 1,048,689 plaintext bytes, WAL reopened at generation 3, no Cutover |
| `node scripts/run-github-e2e-disposable.mjs wal-backup-ambiguous` | `30c10181-ee6a-4a4d-b37c-262cc09b74ad` | **PASS**, exit 0, 1/1 test, 7/7 files, 1,048,689 bytes, WAL pending at generation 2 before restart-like reopen, generation 3 after independent reconciliation |

The second case injects **one controlled unknown/lost GitHub create response**
*after a real create-only POST succeeds*. It then aborts same-run recovery
so the still-unresolved WAL intent is read from freshly reopened physical
storage. The owner-approved **production** best-effort
`reconcileV4PendingFrozenBackupWithJournalBestEffort` independently
reauthenticates the complete remote Backup, records the exact observed ref,
and **makes no GitHub mutation/no POST retry**. It never grants
Destination publication, Settings/Index Cutover or automatic Sync resume.
The experiment simulates a lost response between requests; it does **not**
kill a process, model a full restart of installed Obsidian, or prove
electrical power-loss/fsync durability. Installed WAL process-kill behavior
was proved separately under D377.

In each scenario the Source advanced by regular encrypted Sync while
the Backup stayed frozen at its original commit SHA. Parent test wrapper
and an **independent** read-only cleanup checker each reported twice-
verified absence for the two branches:

- Normal: Source `fc625ed7-90ed-4a53-b221-b469a121691e`, Backup
  `47911fa2-99df-4239-ab5f-a9beb101d100` — both exit 0.
- Ambiguous response: Source `79ed63fa-a6cd-4eb0-90b2-0c9b7a849e2e`,
  Backup `d238e794-bbf9-4e24-a29f-2d9bfc44ffb9` — both exit 0.

## Invariants, tests and release boundary

- `pnpm typecheck:max-strict`, `pnpm test:github-e2e:compile`,
  `node --check scripts/run-github-e2e-disposable.mjs` and
  `git diff --check` all passed after adding the test-only scenarios.
- No production source/runtime code change; only E2E test/harness and
  documentation. Never enable GitHub Actions.
- The first public release gate `docs/release-gates/reencryption-wizard.json`
  remains `blocked` with six pending checks. The D376 full Fast 1,615/1,615
  proof covers an older fingerprint and must not be presented as qualification
  of the D378 working tree.
- Next high-value proof: Join WAL-backed verified Backup to new-key staged
  object receipts, candidate preparation, Destination create-only publication,
  full readback and installed owner-scoped Settings/Index Cutover. Keep
  other-device reconfiguration manual and stop on unknown remote outcomes.
