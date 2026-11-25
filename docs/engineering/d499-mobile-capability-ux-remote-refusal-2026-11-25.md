# D499 — Early mobile size refusal and actionable recovery

2026-11-25. Production fix `b40af7b85ad172889d52830a5faa70cdab66fed5`: explicitly pass ordinary mobile Sync file size ceiling (32 MiB) to session IO; refuse oversize local scans, incoming pull plans and remote content reads before transfer with a typed actionable error. Desktop bounded transfer behavior unchanged; no Re-encryption policy change. Local guidance warns that moving previously synced files out of a Vault may propagate deletion; recommends backing up and reducing file size. Remote guidance instructs reducing the file on Desktop, syncing there first, then retrying normal Sync without force overrides. Tests exercise exact ceiling and oversize refusal, no content read or mutation and recovery after size reduction. Clean Sync Session 145/145, Settings/Secrets 78/78, maximum-strict typecheck and production build all exit 0.

Native test runner `ef45a0912cbac3b38ac56d78fb12e882a882f4ce`: actual Android 13 and Windows Obsidian, pinned disposable GitHub repo 1284153873. Verified exact D496 Vault and six existing synthetic paths, unconfigured credentials before installing updated main.js in only that Vault. Obsidian force-stopped, explicit Vault URI opened; actual PID changed 18707 → 22833. Production bundle hash on Windows and Android both `bfeb5bfc6ee1d829c6f818047024e329771e7f0c9e7683af1a720b1eb84f1b40`. This is successful installation/reopen, not startup sync with persisted credentials.

## Live results

Task 438b546d-401b-4e21-b199-0e8b7b609944 exit 0 PASS. Initial Android normal publication of all six existing synthetic files, including 32 MiB, completed 30 requests/0 failures. Windows published new synthetic 33,554,433-byte file (32 MiB + 1 byte), SHA-256 `f42e35e66ce8dea5b995a36b099c777980282ebf87e3487ba9e0e70139b7560b`. Android normal Sync refused in planning: status failed, changedFiles 0, uploadBytes 0, downloaded only 41,580 API bytes (metadata, not full content), 11 requests/0 API failures. New actionable message observed in progress error, including path, 32 MiB limit and desktop reduction guidance. Local target absent, existing 32 MiB file SHA unchanged, remote HEAD unchanged.

Windows reduced only its known generated fixture to 1,048,576 bytes and normal Sync published revision. Android normal retry completed successfully (15 requests/0 API failures, 1 changed file, 1,093,507 API download bytes, 0 upload bytes); ADB disk SHA matched `23e7d18fa53f2a863310856b76d3863d1e9b5f55ea6236a228d38b80b4baef9b`. Existing 32 MiB hash remained unchanged. Final normal Sync no-change, no pause, remote HEAD unchanged. Separate ADB disk hash task 77f8f5e8-c706-4a73-a359-fa22335ec1f2 confirmed reduced revision. No force recovery on Android. Initial peer restore uses Force Pull only for disposable Windows setup.

| Phase | API requests | Failures | Result |
| --- | ---: | ---: | --- |
| Android initial 6 files | 30 | 0 | PASS |
| Windows publish 32 MiB + 1 | 22 | 0 | PASS |
| Android oversize pull | 11 | 0 | Expected early refusal |
| Windows reduce and publish | 17 | 0 | PASS |
| Android retry | 15 | 0 | PASS |

## Cleanup and scope

Runner secretCleanup true, branchCleanup true. Independent read-only check 51e00226-9b3d-463d-b0e8-356f2326693d confirmed branch obsidian-sync-e2e/local-ef45a0912cba-51729a8496029bd2 absent twice. Both created ADB forwards removed. Android Vault retains seven synthetic files (six D498 files plus Assets/android-from-windows-oversize.bin now 1 MiB with hash above). Sync disabled, credentials cleared. No personal Vault, default/source branches, OS networking or releases altered. Largest new file 32 MiB + 1 byte, well under user cap 500 MiB.

Remaining: Android process restart with persisted credentials and startup Sync, scoped mobile transport interruption, physical iOS, final publication interruption, bulk and full release qualification. D499 actual new upload UX verified by regression; native oversized local upload previously verified in D498 before the improved message. Native new remote pull refusal and recovery fully qualified. No claim about mobile memory usage or support above 32 MiB.
