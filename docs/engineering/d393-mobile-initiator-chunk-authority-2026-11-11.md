# D393: recheck Mobile initiating authority before each buffered chunk

Date: 2026-11-11. Local D87 worktree only. Release gate remains blocked.

## Defect and impact

`createV4MobileInitiatorLocalReader()` uses Obsidian's bounded, whole-file `DataAdapter.readBinary()` to read files of up to 32 MiB. It then exposes the resulting `ArrayBuffer` in chunks of at most 8 MiB to the authenticated local parity verifier. Before D393, the iterator checked the AbortSignal between chunks but did not recheck the initiating lease, Sync generation, Source settings, open editor state, or adapter identity after its first yield.

An async consumer could obtain a first chunk, lose its initiating authority, and still obtain a **second** chunk from the already allocated buffer. The final full-vault parity procedure still checked authority and was not shown to authorize Cutover incorrectly. The defect was narrower: the Mobile reader failed to revoke access promptly at the next chunk boundary. This is important because production code must not depend on an eventual end-of-stream failure to stop handing data to a caller after authority loss.

## Smallest change

In `src/lib/v4/reencryption-mobile-initiator-reader.ts`, the chunk loop now calls the existing `assertGuard(signal)` before each yield. That guard already checks the original DataAdapter methods, initiating lease, idle Sync state, Source identity, editors, and cancellation, including rechecking after awaited editor enumeration. The fix adds no new state or helper and does not change plaintext bytes or the 32 MiB initiation limit. It does **not** claim a filesystem-wide lock, atomic file snapshot, or native Android/iOS acceptance.

## Reproducible tests

- **RED before code fix:** `node scripts/run-tests.mjs --tier=fast --filter=tests/v4/reencryption-mobile-initiator-reader.test.ts --name-pattern=^D393`, task `d658543e-0c91-4d39-95e7-8589cbfdc063`, **exit 1**. The test obtained a second chunk after the lease was revoked; Node reported "Missing expected rejection".
- **GREEN after fix:** Same focused D393 test, task `9392e974-73e3-453f-95d4-a95fbe43ca84`, **1/1 PASS, exit 0**.
- **Mobile reader suite:** `tests/v4/reencryption-mobile-initiator-reader.test.ts`, task `352d2b4e-4001-44e5-a637-9aeb7e0c3f67`, **21/21 PASS**. New D393 checks revoke the lease, activate Sync, change Source, open an editor, or replace a guard method after the first of several chunks. An existing runtime integration now additionally proves a **completed intervening Sync** invalidates the second chunk from the same `V4PluginRuntime` reader. A separate D393 case reads an exact 32 MiB file as four 8 MiB chunks under valid authority, with exactly one `readBinary()` call and no writes.
- **Related integration:** `tests/v4/reencryption-mobile-runtime-wal-authoring.test.ts`, task `60c4149d-5e66-4d66-85fe-f74888329ac8`, **5/5 PASS**. `tests/v4/reencryption-initiator-parity.test.ts`, task `2204f9b7-a91d-42b5-9d43-26b79e48ae95`, **16/16 PASS**.
- `pnpm typecheck:max-strict`, task `fb43e1cf-3e0a-4890-a6d8-5554ebd3c123`, **exit 0**. `pnpm typecheck:github-e2e`, task `2a3c8650-36b1-4f19-9dd9-f7ad12fe5645`, **exit 0**. `pnpm build`, task `e01c3959-5548-41e4-84df-f1360e19f680`, **exit 0**.

Full current-source Fast qualification is tracked separately in the D393 handoff. Do not reuse the D392 content fingerprint after this source and test change.

## Safety and remaining release blockers

This repair affects only Mobile initiating-file reads and tests. No real Vault, GitHub branch, token, Settings/Selector/Index, stale-lock policy, Release Receipt, or Cutover was changed. The project still requires Sync and Re-encryption together in the first release, 8 MiB encrypted transport parts, capability-gated Mobile initiation at up to 32 MiB, best-effort Manual Recovery and no GitHub Actions.

Android and iOS have not been physically tested by this stage. The installed authenticated Source to frozen Backup to Staging to orphan Destination chain is not yet proven under one native owner lease, and restart-safe committed Settings/Selector/Index Cutover plus stale-device recovery remains unqualified. Keep `docs/release-gates/reencryption-wizard.json` blocked.
