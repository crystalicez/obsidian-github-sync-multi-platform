# D496 — Real native attachments, restart and transport interruption

2026-11-24. User explicitly capped each test file at 500 MiB (524,288,000 bytes). Clean detached Windows Obsidian qualification worktree, production code unchanged from D494 fix 5b3d83a. Runner only changes at 8fdd1ac, ace5b83, 590eae4. Actual installed source and peer Vaults, actual GitHub API on pinned disposable repository ID 1284153873. Synthetic random binary fixtures generated and SHA-256 verified in bounded streaming reads/writes; no mocked Vault/transport. 501 MiB rejected before filesystem/remote writes. No personal Vault or default/source branch changes.

## Native acceptance outcomes

| Test | Tested SHA | Result |
| --- | --- | --- |
| 128 MiB encrypted roundtrip + online restart | 8fdd1ac30c0bcefcad9ff51b6f7a91edff76779e | PASS, exit 0 |
| First 500 MiB encrypted roundtrip | 8fdd1ac30c0bcefcad9ff51b6f7a91edff76779e | FAIL after successful upload: UI sampled one API request still in flight; peer not exercised |
| 500 MiB retry with bounded request quiescence | 590eae4bb84828b536c07a6fd1fd521f84c5f487 | PASS, exit 0 |
| 16 MiB actual transport interruption and normal retry | 590eae4bb84828b536c07a6fd1fd521f84c5f487 | PASS, exit 0 |

Commands from clean detached worktree (using existing ignored root E2E env, no token displayed):
```sh
node --env-file-if-exists=../../.env.github-e2e scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --verify-peer --native-file-mib=128 --restart-journey --assert-diagnostics --expected-repo-id=1284153873
node --env-file-if-exists=../../.env.github-e2e scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --verify-peer --native-file-mib=500 --assert-diagnostics --expected-repo-id=1284153873
node --env-file-if-exists=../../.env.github-e2e scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --verify-peer --native-file-mib=16 --network-journey --assert-diagnostics --expected-repo-id=1284153873
```

| Metric | 128 MiB | 500 MiB | 16 MiB retry |
| --- | ---: | ---: | ---: |
| Source binary size bytes | 134217728 | 524288000 | 16777216 |
| Upload wall ms | 86941.6 | 280086.5 | 22704.5 |
| Peer download wall ms | 107812.7 | 184962.3 | 12955.7 |
| Source upload renderer peak RSS bytes | 322588672 | 321056768 | 304377856 |
| Peer renderer peak RSS bytes | 264929280 | 285802496 | 268451840 |
| Source binary upload API requests | 34 | 80 | 19 |
| Peer restore API requests | 56 | 144 | 23 |
| API failures on successful upload/restore | 0 | 0 | 0 |
| Source warm binary no-op ms | 2635 | 2141.2 | 2147.8 |

Upload transport byte counts include GitHub API encoding overhead (500 MiB fixture: 699096288 bytes); cap applies to actual fixture, not encoded network traffic. RSS is individual renderer, not total process tree. Single measurements, not a comparative performance benchmark. Exact source/peer disk SHA-256:
- 128 MiB: b2a06c43deb154a3cf6ff0a1fac3bacefc077236ff2c39bf0e74226829c3d7a9
- 500 MiB: 337852eaef40ffd95ecb6a347874a2113ac83126392cb94d3be7efa0e986c51b
- 16 MiB: 4994f207b8db1e73c85a27513304f6bde1f84943b844d423570f66b08f2f07b7

128 MiB actual owned source process terminated/restarted; credentials and Device ID persisted, attachment hash unchanged, warm no-op unchanged HEAD, new note published without re-entering credentials and restored in peer. 500 MiB first run uploaded in 348167.1 ms with 80 requests / zero failures, but metrics sampled a live follow-up request. Added bounded wait for request quiescence, no assertion removal. Second run completed full peer restore and source no-op, no UI exceptions.

## Real scoped network cut

Loopback CONNECT proxy restricted to api.github.com:443, no TLS termination, payload inspection, global networking or certificate changes. Actual upload phase and tunnel traffic/active sockets proved before cut; closed 2 sockets, 3 API failures, failed lifecycle and automatic Sync paused; GitHub HEAD unchanged and original disk SHA-256/size preserved. Restore tunnel, normal manual Sync succeeds, automatic pause clears, peer restores exact 16 MiB bytes, no-op unchanged HEAD. Initial peer setup uses Force Pull; recovery on source does not. Does not prove ref-publication ambiguity, physical radio loss, or interruption of every phase.

## Cleanup receipts

- 128 MiB task 8fa061da-a7f2-42e3-99e4-f1c2efc4942b, branch obsidian-sync-e2e/local-8fdd1ac30c0b-c662a951714024be: PASS, absent-verified and independent absence twice.
- First 500 MiB task f0428db6-3451-47a3-9313-0223ab56115e, branch obsidian-sync-e2e/local-8fdd1ac30c0b-18653c2d6598e967: FAIL (diagnostic assertion), cleanup absent-verified.
- 500 MiB retry task f0fcb369-a6f1-4465-b9c0-153bae03f170, branch obsidian-sync-e2e/local-590eae4bb848-e85b7dcf6d7baad9: PASS, independent read-only absence twice (29905e9a-2af6-4c5e-b265-c1e681a74228).
- 16 MiB network task 5ceb2aa1-c0f7-4daa-8211-fa41066cf901, branch obsidian-sync-e2e/local-590eae4bb848-be397995a1d6eea7: PASS, independent read-only absence twice (a1b050fb-e310-4cc0-8a0b-1317aeb69a6e).

## Remaining

Physical Android 13 with installed Obsidian detected; disposable Vault path not found, no verified isolated mobile test environment, no iOS device verified. Do not operate on personal mobile Vault. Mobile platform capability limits and re-encryption 32 MiB gate must remain distinct from actual Windows 500 MiB qualification. Bulk 1000-note, plaintext native peer, ref-publication interruption, full release candidate qualification remain open. Full offline suite not rerun here; respect 500 MiB cap for any large-file tests. No product code change, release, merge or tag. Original Re-encryption WIP preserved.
