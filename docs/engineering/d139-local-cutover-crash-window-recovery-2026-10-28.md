# D139: Local Cutover crash-window classification (read-only, NOT an enabled commit)

Date: 2026-10-28. Re-encryption Wizard remains **Preview-only**, with public release gate **blocked**.

## Purpose and scope

The independent Source/Backup/Destination Git evidence and D138 cross-surface proof are still observations, **not** a crash-durable local transaction. Settings (Obsidian `saveData()`), the selected local Index and SecretStorage references have independent persistence boundaries. They can disagree after an interrupted transition. D139 adds `src/lib/v4/reencryption-local-transaction-recovery.ts` with two related, deliberately **non-authorizing** APIs:

- `classifyV4ReencryptionLocalRecovery(snapshot)` is a pure total classifier of observed Settings selector, active Index selector, Shadow completeness, both secret-presence bits and independently authenticated Source Intent/WAL status. It models **144 combinations** (3×3×2×2×2×2) without assuming that any two surface writes are atomic.
- `inspectV4ReencryptionLocalTransactionAfterCrash(input)` takes an explicit caller-held initiator lease, reads actual active and Shadow indices through the supplied adapter, checks saved Settings selector and SecretStorage values and re-reads all those surfaces after any WAL/Intent inspection. It only invokes the existing D136 authenticated encrypted WAL + exact D135 Intent proof when **both current selectors still point to Source**. It requires source and destination secrets to remain accessible. It pins the adapter's `read`, `exists`, `stat` methods, WAL reader, callbacks, run/branch/Git SHA, expected identity and Settings snapshots to reject input swaps across awaited boundaries. No write methods are invoked.

It deliberately does **not** create a transaction marker, choose a commit point, copy or rename the active Index, call `saveData()`, change Settings, select/clear either SecretStorage value, update GitHub or resume Sync. The caller's lease and durability callbacks must be real platform facilities; the tests' stubs do not certify durability.

## Crash-window decision table

| Observed Settings | Observed active Index | Shadow | Both secrets | D135/D136 Source proof | Read-only observation | Automatic recovery |
|---|---|---|---|---|---|---|
| Source | Source | complete | present | valid | `source-prepared-uncommitted` | **Forbidden** |
| Source | Source | complete | present | missing / invalid | `manual-recovery-required` | **Forbidden** |
| Destination | Source | complete | present | irrelevant | `manual-recovery-required` | **Forbidden** |
| Source | Destination | complete | present | irrelevant | `manual-recovery-required` | **Forbidden** |
| Destination | Destination | complete | present | not applicable | `destination-observed-without-commit-proof` | **Forbidden** |
| Any | Any | absent / incomplete | any | any | `manual-recovery-required` | **Forbidden** |
| Any | Any | any | either secret missing | any | `manual-recovery-required` | **Forbidden** |
| Mixed / unknown | Any | any | any | any | `manual-recovery-required` | **Forbidden** |

**No successful-looking Destination observation is an authenticated local commit receipt.** Even if the active Index matches the Shadow and Settings already select the new branch/Secret ID, the report still has `localCutoverAuthorized:false`, `resumeSyncAuthorized:false`, `rollbackAuthorized:false`, `remoteWritesAuthorized:false` and `oldPassphraseCleanupAuthorized:false`.

The logic does not assume that copying/replacing the active Index is the approved eventual production commit algorithm; tests simply exercise both possible crash orders. A future irreversible persistent transaction design must separately prove exact order, idempotent recovery, WAL durability and current platform support; the presence of this decision table is **not approval** for implementing a switch.

## Fault tests

`tests/v4/reencryption-local-transaction-recovery.test.ts` exercises the complete 144-cell matrix and **10 behavior tests** for unchanged Source, Settings-only switch, Index-only switch, both switch orders, missing original/new SecretStorage values, torn/absent Intent, lost WAL Backup/Destination receipts, incomplete Shadow, mutated Settings/Index during WAL, failed lease/durability/WAL, uncooperative holder and swapped local adapter method. A RED test demonstrated that changing the injected adapter `read` function inside the holder previously returned a misleading positive Source observation; D139 now pins reader method references and the test passes GREEN. Source/WAL stays uncommitted in the positive case.

`tests/recovery/reencryption-local-transaction-recovery-windows.test.ts` writes disposable real Windows files: Source Index, Shadow Index, D135 Intent and a simulated `settings.json` snapshot. It then uses a separately constructed read-only adapter to check Source, Settings-only/Index-only interrupted states, both Destination selectors, and post-cutover missing old key, in both orders. No reader invocation writes to any of the three index/intent files. This is **not installed Obsidian**, and the WAL, OS lease and durability callbacks are stubs; saving settings.json directly is a test surrogate, not a test of Obsidian's `saveData()`. File reopen is **not a physical power-loss or reboot persistence proof**.

## Release blockers and next work

- The strict owner-approved full power-loss WAL and cross-surface local transaction guarantees remain **unproved** on Windows Node-only directory `fsync` (`EPERM`), and are unqualified on macOS/Linux and physical Android/iOS.
- No durable, authenticated local **committed** receipt currently exists to distinguish a completed cutover from a crash after one or both selection writes. There is no safe authority to clear the old accessible SecretStorage value.
- D139 does not revalidate live GitHub Backup ref or all D138 remote content, and an apparently consistent destination can be tampered with by an uncooperative local writer. The Source observation uses D136 WAL/Intent, **not** D138 remote content proof. D139 cannot substitute for a cross-process fence or a revalidation at commit.
- Need an independently audited idempotent commit/recovery protocol, platform durability evidence, live authorized disposable three-branch GitHub test and native two-device Obsidian acceptance. Owner confirmation is required for any architectural change that weakens crash-safety or adds a Native Helper; no such choice is made here. No GitHub Actions, live Vault mutations, branch deletion, force push or release.

**Final verification:** D139 focused **10/10**, exhaustive pure matrix 144 combinations, real Windows reopened-filesystem recovery **1/1**, full Fast **1006/1006**, exact-source 10-round Fast repeat **10 × 1006/1006 PASS, exit 0, zero failures**, Recovery **86/86**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, Production Build, GitHub E2E compile-only three bundles, package and release validations, and SHA-matched cryptographic soak capped at **100,000,000 bytes** all PASS. None of these certify real hardware power-loss persistence or native Obsidian settings durability. Final commit and push evidence are recorded at the top of `HANDOFF-NEXT-SESSION.md`.
