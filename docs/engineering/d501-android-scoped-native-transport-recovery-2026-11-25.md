# D501 — Android scoped native transport recovery

2026-11-25. Actual Android 13 SM-N770F, installed Obsidian plugin 1.0.8, Windows installed Obsidian peer, exact previously user-opened synthetic D496 Vault only. Test repo pinned ID 1284153873. No OS network, proxy, certificate, Wi-Fi or personal Vault changes. Maximum new fixture 8 MiB below 32 MiB mobile ceiling and user 500 MiB cap.

## Negative capability result and test method

First run c50f1b3fbcd59d3887536022f39903b47a3064a0, task feeb09ce-3aac-410e-abdd-63aa396fbc36, exit 1: eight existing verified fixtures uploaded (34 requests/0 failures), no-op succeeded but observed zero actual GitHub calls through Capacitor.nativePromise. Stopped before injecting failure or creating a new fixture. Both credentials and branch cleaned. Do not interpret as a network recovery pass.

Second test-only commit 22da45a8d01065bb05b08cfe337109755fd5e33d builds separate ignored .tmp/d501-android-transport-test/main.js via esbuild, intercepting only the exact requestUrl call in github-api.ts. No production source or normal main.js modification. Production bundle SHA-256 bfeb5bfc6ee1d829c6f818047024e329771e7f0c9e7683af1a720b1eb84f1b40; instrumented bundle SHA-256 5196bc4ca770b84fa279a68abfc0c808243e03a46ec267f2137f5a052e8e8955. Both verified on Android at installation/restoration. Test hook initially observes and passes requests unchanged. During intended upload only, exact pinned disposable repo blob POST is redirected to actual native requestUrl HTTPS GET to a loopback TCP sink via owned ADB reverse. Sink closes actual connections during TLS handshake. Fresh request options contain no credentials or Vault body. No TLS interception/cert changes. Original production request, scheduler, mutation retry, progress and recovery logic otherwise unchanged. This is scoped native transport fault injection in an instrumented bundle, NOT a real in-flight GitHub socket cut, system-wide outage, or proof of network interruption during final ref publication.

## Native acceptance

Task a8a5b021-8844-46d1-ab36-202d3d681249 exit 0 PASS. Initial eight verified files uploaded 34/0 requests/failures. Hook observed 5 actual requests during normal no-op. New random 8,388,608-byte Assets/android-network-02197b9cb990415e.bin, SHA-256 eab88ffb974dd84649c255db2137cf268866c00d6ed5f048185d1a3482bbe7d2, exact scoped disk ADB verification. Three attempted blob calls redirected; three native request rejections, three loopback TCP connections, 756 received handshake bytes, no successful fault responses. Fault observed in uploading phase for exact intended file, active true. Terminal failed with 0 changed files, 10 API requests/3 failures, 0 in-flight, Auto Sync paused, unknown immutable-idempotent mutation outcome. Remote HEAD and local source hash unchanged. Diagnostics uploadBytes counts attempted request bodies, not real bytes sent to sink; sink saw only handshake bytes.

Restored test hook before ordinary Manual Sync (no Force Push or Pull). Completed success, changedFiles 1, 19 requests/0 failures, 0 in-flight, Auto Sync unpaused, remote HEAD advanced. Windows independently installed peer downloaded exact new 8 MiB fixture and verified SHA-256; initial peer Force Pull only as disposable bootstrap. Final Android normal no-op, unchanged HEAD. This does not independently exercise a subsequent automatic event after recovery (D498 covers native Auto Sync).

| Phase | API requests | API failures | Result |
| --- | ---: | ---: | --- |
| Android initial eight files | 34 | 0 | PASS |
| Native injected upload failure | 10 | 3 | Expected safe failure |
| Normal retry after restoring hook | 19 | 0 | PASS |
| Windows peer SHA-256 and final no-op | — | — | PASS |

## Cleanup and final device state

Both runners secretCleanup true and branchCleanup true; independent read-only branch absence twice:
- obsidian-sync-e2e/local-c50f1b3fbcd5-7ad98de103ce677d (1e92fc71-2d00-455f-8a66-47aafb6088a1)
- obsidian-sync-e2e/local-22da45a8d010-02197b9cb990415e (0a81cd79-4755-4f43-9f00-aae73e3c64bb)

Independent Android disk SHA matches (37e244b8-93d6-478c-94a3-9391511b4a2e). ADB reverse list empty. Original production main.js restored to exact disposable Vault and verified SHA above (57f0e807-55df-45b8-81ff-5a7f4da41f33). Explicit reopen PID 26402, exact Vault correct, loaded, unconfigured, nine known synthetic paths (902dc924-53dd-4249-8208-132168f9e585). All created ADB forwards removed, final verification forward removal 3d43168e-54d4-4b3a-8e6d-e5f0a394e5c0. No test hook or instrumented bundle left on Android, Sync disabled and credentials blank. Keep only D500 eight files plus above new synthetic 8 MiB fixture. Test-only bundle not release artifact; normal production bundle unchanged. No production code changes or release. Remaining: real Android GitHub socket outage without broad network modification (not proven), final publication response-loss/ambiguity, bulk, iOS and complete release gate. User-visible error still technical; consider actionable retry wording in follow-up.
