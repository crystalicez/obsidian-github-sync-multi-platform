# D500 — Physical Android process restart and Startup Sync

2026-11-25. Actual Android 13 SM-N770F and Windows installed Obsidian, plugin 1.0.8, unchanged D499 production bundle SHA-256 bfeb5bfc6ee1d829c6f818047024e329771e7f0c9e7683af1a720b1eb84f1b40. Explicitly user-opened disposable Vault Documents/ObsidianSync-D496-Disposable; verified exact physical path and seven existing synthetic file names, note contents and known hashes; blank credentials before test. Pinned disposable GitHub repo ID 1284153873 and absent-first branch. No personal Vault, global network, source/default branch, production code or release change.

Runner commit 1f21ac49516a4d5daee12fa06af286ffb977415c adds --restart-journey, native lifecycle helper, before-peer-binary callback, guarded exact path and selected ADB transport/PID forwarding checks. Normal Android initial Sync published seven files, then no-op. Enabled Startup Sync using ordinary Settings Save, disabled local/scheduled triggers. Verified settings readback, same Device ID, distinct SecretStorage slots, matching token and passphrase, no plaintext credentials in persisted settings, no pending save. Shut down actual Android Obsidian only while idle and exact test branch active; verified process absent. Windows peer initially restores isolated Vault via Force Pull, then publishes new random 2 MiB binary using normal Sync while Android stopped. Reopened exact Vault via Obsidian URI and waited for native startup trigger; no manual Sync or credentials re-entry after either restart.

## Native results

Task 67863b7f-d065-4765-814f-29b5e2075864 exit 0 PASS. Actual PID 22833 → 24334 → 24539. First restart native trigger startup, operation normal, success, pending 0, API requests 13, failures 0, upload 0 bytes, download 2,139,657 API bytes. Local binary 2,097,152 bytes SHA-256 eceb4134615117215d2b7788bf53b5cf90f234142095144aea421725b0c2b1cf matched Windows source. Remote HEAD unchanged by Android pull. Settings and SecretStorage checks matched pre-restart baseline, device ID unchanged. Second process restart trigger startup, normal no-change, pending 0, 5 API requests/0 failures, upload 0 bytes, download 7,744 API bytes, HEAD unchanged, both new binary and existing 32 MiB attachment hashes preserved, exact eight logical paths. No startup-trigger calls injected; natural installed app startup. No memory or wall-clock performance guarantee.

| Phase | Requests | Failures | Result |
| --- | ---: | ---: | --- |
| Android initial 7 files | 32 | 0 | PASS |
| Windows publish 2 MiB while Android stopped | 18 | 0 | PASS |
| Android startup pull | 13 | 0 | PASS |
| Android second startup no-op | 5 | 0 | PASS |

Independent Android disk SHA-256 task acd12a7a-9c55-4468-9f69-c0f2d9008b02 matched. All ADB forwards gone (c3926c37-8196-41ed-9b91-e343d1532516). Runner secretCleanup true, branchCleanup true; old credential slots blank, routing fields cleared, startup/local/scheduled sync disabled. Independent read-only branch check 918beb5a-20b3-462e-a191-8ad7a860e56e verified obsidian-sync-e2e/local-1f21ac49516a-34bfcf91f09f8c47 absent twice. Settings/Secrets regression 78/78 (e6d6016d-97a6-40ee-bc7a-be271dc6812d); all three runner syntax checks and scoped diff checks passed. Largest new file 2 MiB, below user cap of 500 MiB.

Retain eight synthetic files only: D499 seven plus Assets/android-from-windows-2mib.bin with size/hash above. Plugin remains installed and open in disposable Vault; no active Sync jobs or debug forwarding. Remaining release gates: scoped Android transport loss, final publication interruption, bulk, actual iOS, full candidate release regression. Restart here deliberately idle, not a crash during publication. No claim of physical iOS support or mobile >32 MiB.
