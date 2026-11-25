# D498 — Physical Android Auto Sync and 32 MiB binary boundary

2026-11-25. Actual Android 13 SM-N770F, installed plugin 1.0.8 and same user-opened D496 disposable Vault, actual Windows peer and pinned live GitHub disposable repo ID 1284153873. No production code changes; unchanged D494 production bundle. User maximum 500 MiB per test file respected (largest 33,554,433 bytes).

## Actual results

First run `1ef11f2` task 5301551d-0e1a-48a1-8530-687dcdb376e6, exit 1 overall: Android uploaded original three fixtures; actual Vault create/modify generated waiting/debouncing/localChange, remote HEAD advanced, pending 0, 18 API requests/0 failures. Independent Windows peer verified resulting auto note, published new random 1 MiB binary; Android normal Sync completed (13 requests/0 failures), disk sha256sum output showed exact source hash. Runner erroneously split on literal backslash-s, failed after successful disk readback. Both secrets cleared and ref deleted. Fix `27ff5f0` corrects whitespace parsing and explicitly reuses exact five synthetic paths, validates existing hashes and auto note contents; no fixture overwrite or deletion.

Second run `27ff5f0`, task 4966e15c-31fe-43f0-ae25-4da3960d0eae, exit 0. Reverified prior 1 MiB runtime and independent Android disk hash. Actual Windows installed peer published new random 32 MiB file. Android normal Sync downloaded exact 33,554,432 bytes, ADB SHA-256 matched, HEAD unchanged. Android modified first byte through Obsidian Vault API and normal Sync uploaded the revision; Windows normal Sync restored it and independent disk SHA-256 matched. Final independent ADB hash matches returned revision.

| Phase | API requests | API failures | Result |
| --- | ---: | ---: | --- |
| Android native Auto Sync | 18 | 0 | PASS |
| Windows → Android 1 MiB | 13 | 0 | PASS (first run disk receipt; reverified) |
| Windows → Android 32 MiB | 21 | 0 | PASS |
| Android → Windows revised 32 MiB | 22 | 0 | PASS |
| Android oversized 32 MiB + 1 byte upload | 5 | 0 | Expected capability refusal; no upload |

1 MiB incoming SHA-256 `e3d86672bd222a49d50bc59b4a0b24f9675c2b9a49d43de53bd4a509a1c6c785`. 32 MiB Windows-origin SHA-256 `2059efffc312e4c661fb4d39f3be966a6d10016291c3bf69609bbdef8db1a63e`; revised Android-origin SHA-256 `034c9f70be9932cb5d9f132df2a75b14bdd04e00136df5997ac07163ef757b63`. ADB readback task b741eab8-6bfb-4022-9281-9db61815d596 confirms final on-device bytes. Diagnostics for 32 MiB: pull 33,599,951 API download bytes, aggregate API latency 25,836.5 ms; upload 44,749,469 API bytes, aggregate API latency 31,037.4 ms. No Android peak memory or elapsed wall-time measurement; API latency not wall time.

Oversized fixture 33,554,433 bytes independently hashed before/after; actual Sync returned failed, changedFiles 0, zero upload, error "V4 bounded-read is unavailable for Assets/android-oversize-8f3ecb073f111b3d.bin." Remote HEAD unchanged, source hash unchanged. Removed only exact generated test fixture after verification. Normal retry completed no-change, pending pause cleared, HEAD unchanged. This establishes a safe current Android upload capability boundary, not support above 32 MiB. Error is technically accurate but should become actionable user-facing guidance; separately test remote >32 MiB download refusal. Re-encryption initiation limit remains separate and unchanged.

## Cleanup and limitations

Both disposable branches absent twice inside runner plus independent read-only checker:
- obsidian-sync-e2e/local-1ef11f23debd-037923305d0ee124 (bd262979-1971-4281-89e2-f6a65722896a)
- obsidian-sync-e2e/local-27ff5f08a69c-8f3ecb073f111b3d (af6f1135-42f7-4777-bda4-b7180d092bfd)

Both runs secretCleanup:true, branchCleanup:true, settings blank and Sync disabled. ADB forward tcp:62561 removed successfully, task 5f74f38d-18b7-4b9d-8dc9-329a979d95a2. Synthetic six files retained: Smoke.md, UI-smoke.md (D497 peer revision), Assets/android-1mib.bin (D497), Auto-Android-037923305d0ee124.md, Assets/android-from-windows-1mib.bin, Assets/android-from-windows-32mib.bin (revised hash above). No personal Vault access, global network change, source/default branch writes, or release changes. Remaining physical Android process restart/startup, mobile network interruption, remote oversized pull refusal, iOS, bulk and full release candidate. Node syntax/diff checks passed. Actual initial Windows peer Force Pull is setup only; Android normal Sync and Windows return pull used normal Sync.
