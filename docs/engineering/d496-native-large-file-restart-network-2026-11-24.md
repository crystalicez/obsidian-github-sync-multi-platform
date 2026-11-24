# D496 — Native Windows attachment, restart and transport recovery

2026-11-24. User authorized remaining actual tests, **maximum 500 MiB per logical fixture**. Production bundle remains the clean build of `5b3d83a29ef10db00f6c269fee0fcdf44d40cbfe` (no product changes since; main.js SHA-256 `80e48e2fcbb8690787ecfc21bfd91b3e3364ed243246dcbc56707099f488e8ee`). Clean detached checkout in `.worktrees/d493-native-live-qualification`; all actual desktop tests ran installed Windows Obsidian and real GitHub with separate synthetic Vaults/profiles, pinned disposable repo ID 1284153873. Initial peer setup uses Force Pull only; source normal Sync used for publication and recovery. No real Vault or default/source branch mutations.

## Runner
- `8fdd1ac`: --native-file-mib=N (1..500 inclusive; legacy --native-100mb remains); 501 MiB rejected before filesystem/network actions. Random independent bounded blocks, independent streaming source and peer SHA-256; --restart-journey reuses only the owned isolated profile and a new CDP port. No credentials re-entered after restart.
- `ace5b83`: test-only loopback HTTP CONNECT tunnel restricted to api.github.com:443; no TLS decryption, content inspection, credential logging, global network/OS setting changes. --network-journey uses a separate 8–32 MiB file; verifies actual tunnel traffic and in-flight upload before closing sockets.
- `590eae4`: bounded 30s wait for completed Sync Center metrics to settle; still requires zero in-flight requests and API failures. Restart port bounds fixed. Node syntax and scoped diff checks passed.

## Actual encrypted roundtrips

| Test | Upload wall ms | Upload requests / failures | Peer restore wall ms | Peer requests / failures | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| 128 MiB (134217728 bytes), restart | 86941.6 | 34 / 0 | 107812.7 | 56 / 0 | PASS |
| 500 MiB (524288000 bytes), first attempt | 348167.1 | 80 / 0 | not run | not run | FAIL overall; upload and source hash passed, UI snapshot had 1 in-flight request after completed Sync |
| 500 MiB, second attempt | 280086.5 | 80 / 0 | 184962.3 | 144 / 0 | PASS |
| 16 MiB (16777216 bytes), transport interruption/recovery | 22704.5 (retry) | 19 / 0 (retry) | 12955.7 | 23 / 0 | PASS |

128 MiB SHA-256 `b2a06c43deb154a3cf6ff0a1fac3bacefc077236ff2c39bf0e74226829c3d7a9`; source and peer peak renderer RSS 322588672 and 264929280 bytes. Source process forcibly terminated only after idle, then restarted on fresh port with same profile; persisted Device ID, exact credentials, mode and attachment bytes verified without Settings Save, warm no-op unchanged HEAD/0 upload, newly created After-restart.md published and verified on peer.

500 MiB first source hash `701cb2cc27fb89a872de015649a069b267e09d6a8f4137f19a3557128fe80770`, upload succeeded; UI diagnostic assertion stopped before peer. This failure is retained, not recast as a pass. Second run SHA-256 `337852eaef40ffd95ecb6a347874a2113ac83126392cb94d3be7efa0e986c51b`; peer disk size and SHA-256 equal; source/peer peak renderer RSS 321056768/285802496 bytes (~306/273 MiB). Upload API bytes 699096288, peer download bytes 524506043. Warm no-op 2141.2 ms, zero upload, unchanged HEAD; 0 UI exceptions. Measurements are observed renderer RSS only, not total process/system memory or general performance guarantees.

## Actual isolated network interruption

16 MiB SHA-256 `4994f207b8db1e73c85a27513304f6bde1f84943b844d423570f66b08f2f07b7`. Actual live GitHub TLS tunnel confirmed; observed phase uploading and active API request for the binary, cut 2 sockets, 3 API failures, terminal failed and Auto Sync paused, remote HEAD unchanged, source size/hash unchanged. Restore tunnel, ordinary manual Sync completed, Auto Sync resumed, published new HEAD, no-op unchanged HEAD, second real Vault restored exact file size and SHA-256; 0 UI exceptions. This proves controlled real connection loss during content upload, not an interruption at final ref publication/ambiguous response or a machine-wide internet outage.

## Branch receipts
All four fresh disposable branches were absent-first and independently verified absent twice after cleanup:
- `obsidian-sync-e2e/local-8fdd1ac30c0b-c662a951714024be` — 128/restart PASS (task 8fa061da-a7f2-42e3-99e4-f1c2efc4942b), cleanup check 7c42dfb2-c6a6-4600-845d-a9b6ca5ec9a2.
- `obsidian-sync-e2e/local-8fdd1ac30c0b-18653c2d6598e967` — first 500 UI assertion FAIL (task f0428db6-3451-47a3-9313-0223ab56115e), cleanup check d0da0518-58f7-4349-960a-dcaf4ebc5c3e.
- `obsidian-sync-e2e/local-590eae4bb848-e85b7dcf6d7baad9` — 500 PASS (task f0fcb369-a6f1-4465-b9c0-153bae03f170), cleanup check a03766fe-1208-48f6-a41b-0a207bf45d6b.
- `obsidian-sync-e2e/local-590eae4bb848-be397995a1d6eea7` — network PASS (task 5ceb2aa1-c0f7-4daa-8211-fa41066cf901), cleanup check 371ef017-051c-4019-bace-0b2b220127fa.

Deletion of refs does not assert deletion of unreachable Git objects on GitHub. All fixtures synthetic/encrypted, no personal content.

## Physical Android preparation (not Mobile PASS)
ADB found one physical Android 13 device with Obsidian installed and not running. No iOS device verified. Created a new exact previously absent folder `/sdcard/Documents/ObsidianSync-D496-Disposable` containing the production bundle, manifest, stylesheet, synthetic Smoke.md, and community-plugins.json. Verified on-device main.js SHA-256 matches desktop above and plugin directory contains only those three bundle files. No data.json, token, passphrase, app launch or personal Vault access; no OS settings changed. Retained this clearly named disposable folder for user to open explicitly so startup of the user's prior Vault is not triggered by automation. Mobile Sync actual acceptance requires opening this Vault as a new separate Vault, then verifying installed plugin/load, scoped credentials and live roundtrip. Current mobile >32 MiB bounded read/commit remains capability-gated per docs/testing/v4-windows-android-validation.md; desktop 500 MiB does not imply mobile support.

Remaining release gates: physical Android/iOS actual plugin sync, mobile capability limits, interruption during final publication/ambiguous write, full candidate regression and release qualification. No tag/merge/release. Existing unrelated Re-encryption WIP untouched.
