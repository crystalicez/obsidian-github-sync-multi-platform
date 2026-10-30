# D163 — Owner accepts simulated power-loss testing, not hardware power cuts

Date: 2026-10-30. Decision scope: Re-encryption power-loss **test acceptance**. No release or production Cutover approval.

## Decision

The owner explicitly declines actual power-off testing and accepts best-effort simulated fault coverage for this area. Do **not** require a physical power-cut rig, dedicated hardware, forced SSD power removal or real electrical interruption as a prerequisite. Keep the project Node.js-first, without GitHub Actions or an unapproved Native Helper.

Acceptable test methods include deterministic fault injection at WAL/Selector, Settings, SecretStorage, active Source/Shadow Index, metadata/ref publication and Cleanup transitions; interrupted/torn writes; simulated cache persistence or reorder/lost-ack outcomes; process termination and restart; independent disposable test fixtures and replay/recovery verification. Test all reachable states where possible. Use the established limit of 100,000,000 bytes for an actual test file. None of these tests is evidence of physical power-loss durability on arbitrary OS/filesystem/storage combinations.

## Invariants that do not change

- Retain Source, verified Backup and any old secret needed for recovery; no automatic deletion or old-key cleanup until recovery is independently safe.
- Treat unverified or ambiguous remote mutation outcomes as unknown. Do not blindly replay a Git ref mutation.
- Require authenticated remote content, pinned GitHub repository/ref identity and a correct zero-parent Destination candidate; no silent cross-branch merge or forced device migration.
- For inconsistent or insufficient local evidence after restart, fail closed and preserve all recoverable data for manual recovery. Do not make a mixed Settings/SecretStorage/Index selection look committed.
- The existing production `assertCrashDurable()` / directory-sync checks are not automatically changed or bypassed by changing **test methodology**. Windows Node directory `fsync EPERM` is a known separate engineering constraint. Changing this fail-closed behavior to a weaker best-effort *write protocol* changes recovery risk and requires an explicit owner decision.
- Do not mark `interruptedMigrationRecovery` passed or change the checked-in release-gate status from `blocked` without a working implementation and its own simulation and installed-client acceptance. No production Re-encryption is currently enabled.

## Evidence and limits

`src/lib/v4/reencryption-owner-decisions.ts` records `powerLossTestAcceptance: "simulation-only-best-effort"`, `physicalPowerLossGuaranteeClaimed: false`, and `unverifiedDurabilityMayAuthorizeCutover: false`. A policy regression test pins those values. Existing D141 fault model, D149 Windows process-kill test and D150/D151 external-writer experiments are useful starting evidence, **not** physical power-loss proof or a complete migration acceptance run.

Open engineering question for the owner only when implementing a real Cutover: is the existing hard `assertCrashDurable()` barrier still required, or may an explicitly documented best-effort recovery design proceed on a platform where Node directory sync is unsupported? Do not infer the latter from the test acceptance decision.
