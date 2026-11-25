# D497 — Physical Android to Windows encrypted sync

2026-11-25. User explicitly opened the previously prepared disposable Android Vault `Documents/ObsidianSync-D496-Disposable`. ADB found Android 13, SM-N770F, Obsidian process and actual WebView. Read-only renderer probe verified exact vault name and normalized physical path, fs adapter, plugin 1.0.8 loaded, unconfigured settings and only Smoke.md. No personal vault access.

## Native acceptance
Production bundle unchanged since D494. New runner `scripts/run-android-live-github.mjs` uses actual Android CDP, pinned disposable GitHub repository ID 1284153873, exact vault identity and initial file allowlist, random ephemeral passphrase, Settings Save, real installed plugin runtime, independently installed Windows Obsidian peer and byte verification. Actual Android and Windows, no mocked transport or adapters. Test fixture 1 MiB, below user's 500 MiB cap.

- First attempt `db87a0f`, task b6aa59f3-bb10-411a-9870-0af58386c541, exit 1. Android normal Sync uploaded three files, 20 API requests, zero failures. Windows peer exact note and binary SHA-256 checks passed before legacy desktop-only hardcoded visible-text assertion failed. This is not full acceptance. Settings secrets scrubbed, branch absent verified twice.
- Runner fix `d677f5f` derives visible text from expected note, not a fixed desktop phrase; explicitly reuses only exact allowlisted existing synthetic fixtures with checked content and size, no fixture overwrite. Syntax checks and diff checks pass.
- Second attempt `d677f5f`, task 57e0e962-f26f-4ed9-82d4-4740f0273a6c, exit 0, native roundtrip PASS. Android normal Sync published 3 files on new branch; Windows peer recovered exact 2 Markdown notes and 1 MiB binary, opened expected note editor, then published an edit. Android normal Sync applied the peer edit to local disk. Final Android no-op unchanged remote HEAD. Independent ADB sha256sum and cat verified final local disk.
- Binary 1048576 bytes, SHA-256 `794b7f16e056bc9c3afd0e3f71efe45c6b32b16b2757c698bf48719fe539c653` identical across Android runtime, Windows physical file, and Android disk via ADB.
- Android upload 20 API requests, 0 failures, 1406196 upload bytes / 5844 download bytes. Android pull peer note 12 requests, 0 failures, 0 upload bytes / 27837 download bytes. In-flight requests zero. No Android RSS or wall-clock benchmark measured. These are observed counts, not general guarantees.
- No Force Push/Pull on Android; initial independent Windows restore uses Force Pull. Binary tested Android upload and Windows download, not Windows-origin binary download to Android. No simultaneous conflict test, Android restart, Auto Sync, network interruption, 32 MiB boundary, or iOS qualification in this stage.

## Cleanup
Both runs report secretCleanup:true and branchCleanup:true (two readbacks after cleanup). Old token/passphrase storage slots independently checked blank by runner, syncEnabled false, repository fields cleared. The synthetic Android files remain for next qualification; settings now unconfigured. Windows test peer/profile and screenshots disposed by existing cleanup helpers. ADB forwarding tcp:62864 removed successfully (task bf0f4d68-4ac8-4f60-b86c-fe606724936f). No changes to OS-wide network settings, personal data, default branches or production code.
Branches:
- obsidian-sync-e2e/local-db87a0fec468-87f78974a643c5dd
- obsidian-sync-e2e/local-d677f5f0d752-6956187e236947c7

Remaining: actual mobile download of new binary, boundary capability refusal/32 MiB and mobile restart/Auto Sync, iOS, complete release qualification. Existing desktop 500 MiB proof does not imply mobile 500 MiB support.
