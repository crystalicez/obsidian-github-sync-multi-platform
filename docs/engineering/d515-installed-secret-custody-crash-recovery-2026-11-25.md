# D515 — Installed secret custody and missing-secret recovery

Status: offline repair qualified; native end-to-end repair NOT qualified.

Production changes: daf4b3084f1098928f6e53f5f2bf740ae4839223 stages distinct destination SecretStorage ID with authenticated AES-GCM receipt before secret write; preserves old settings/key/token; receipt contains no secret value. 8e393f38f0c4bffc5cee3773dced5c1697478c5c adds safe failure-stage diagnostics. 3eeb4db62c55b33ba60b28d1eb46ef39110afbe1 adds explicit missing-secret repair: read-only inspection never writes; reentered destination passphrase must verify exact frozen Backup, WAL, Destination, Shadow, owner, fence, lease, refs and receipt. Restore only the original empty ID; reject wrong passphrase and occupied slots. No settings switch, old-key removal, remote mutation, automatic recovery writes or cutover. No physical durability claim.

## Native findings

- ecf78f7e-c34c-41b7-9460-0c5320a2f5fa: original stage/readback succeeded; post-restart recovery failed.
- 4d77baea-7b5c-4653-a7e3-3fcbd67e1324: diagnostic retry failed with failureStage=secret. Redaction truncated custody booleans; exact full-journey cause not uniquely proven.
- 55fe41dd-753e-43b4-ab92-cd1f92fc2507: independent actual Obsidian probe (no GitHub credentials). All three fresh synthetic SecretStorage writes read back successfully in-process but persisted=false after forced process termination at 0, 1000 and 5000ms. Probe exit 0, UI exceptions 0, temp removed. This demonstrates possible loss of fresh writes, not normal-shutdown behavior or physical power-loss guarantees.
- 9adec916-2a5b-43c8-bbca-33010ee619a3: repaired stale-client journey stopped by CDP Runtime.evaluate timeout before confirmed migration, exit 1, temp removed.
- 480eb2e1-a46f-4e4b-b27a-d5b9ca6fcadb: repaired single-Vault journey CDP timeout, all three remote refs absent twice. Latest task observation: {"task_id":"480eb2e1-a46f-4e4b-b27a-d5b9ca6fcadb","state":"failed","exit_code":1,"stdout":"{\"status\":\"ABSENT_FIRST\",\"repoId\":\"1284153873\",\"sourceBranch\":\"obsidian-sync-e2e/local-3eeb4db62c55-c616fa0d1f72eb72\",\"backupBranch\":\"obsidian-sync-e2e/local-backup-c1f30f4dd213de30f4ebb725dd062c9f\",\"destinationBranch\":\"obsidian-sync-e2e/local-destination-5ce1854f2922aee49ad2d643307ca9ff\"}\n{\"status\":\"CLEANUP_VERIFIED_TWICE\",\"branch\":\"obsidian-sync-e2e/local-3eeb4db62c55-c616fa0d1f72eb72\",\"repoId\":\"1284153873\"}\n{\"status\":\"CLEANUP_VERIFIED_TWICE\",\"branch\":\"obsidian-sync-e2e/local-backup-c1f30f4dd213de30f4ebb725dd062c9f\",\"repoId\":\"1284153873\"}\n{\"status\":\"CLEANUP_VERIFIED_TWICE\",\"branch\":\"obsidian-sync-e2e/local-destination-5ce1854f2922aee49ad2d643307ca9ff\",\"repoId\":\"1284153873\"}\n{\"status\":\"FAIL\",\"cleanupState\":\"temporary-vault-removal-unconfirmed\",\"remoteCleanupErrors\":0}\n","stderr":"D412_LIVE_OBSIDIAN_REHEARSAL_FAILED: CDP timeout: Runtime.evaluate\n","started_at":"2026-11-25T15:04:51.036Z","finished_at":"2026-11-25T15:13:58.955Z","deadline_at":"2026-11-25T15:24:51.239Z","durable":true,"worker_pid":40652,"child_pid":32952,"child_started_at":"2026-11-25T15:04:51.416Z","truncated":false}. No successful repaired native journey.

## Qualification

Final repair build ff55f89d-3868-4a03-8503-5f553fa19a98, maximum-strict e0f6afcb-8449-47f9-b467-952f48304774, syntax 7e34f643-e3f2-4344-80fd-0465ad9567a5 exit 0. Installed 6/6 7afc774d-65a8-425d-a9a3-2b65ed0c93ea, Recovery 95/95 4a23c719-4390-4198-ae9a-d5e6baacfd9b, Wizard 34/34 28a1ccf9-a8cf-43ed-a459-cf78da107b8a, all exit 0 with zero skipped. Tests simulate missing key, wrong passphrase, valid restoration, repeat read-only verification, occupied slot, receipt/Shadow tamper. Initial staging Settings 80/80 118aea7b-dd9f-4f6b-8ba5-62f3afc5507c; not rerun after repair. Full current-source Fast not qualified.

## Cleanup

All 12 disposable refs across four live runs independently verified absent twice, exit 0: bf4ea657-a467-4095-a850-c6a4ffb3b3df, 3bb511ad-626b-45ff-8047-a8a21af6e90a, e09f31d6-6c94-4fee-8ebc-c9ad61048dd2, 82acb272-a85d-41d8-aae9-15278b904cec, 83e5341f-0472-476b-b1ca-01bcf3498c97, cc8986e6-59d3-4622-b568-91cf9e43c071, 93366d8d-e761-45f3-acda-6f1292061998, 2498edad-6f47-4414-9c4e-a25b3a6e436b, e7ec07ce-53bb-46a2-ada6-50f9bc5c77e5, 0a81f81b-3814-4338-a2da-a34694ed1405, 00db76c0-4633-4d0e-9396-f5d2594496dd, 07d72cc3-a3ef-4946-9088-0368ac3b1524. Pinned repo 1284153873 only. First three Vault cleanups confirmed. Last local cleanup subject to terminal task result above. No real Vault, default branch, tag or release writes.

## Next

D516: resolve native CDP timeout/cleanup, qualify repaired missing-secret path with real Obsidian. Then public recovery UX, discover persisted authenticated identity, actual selector/Settings/Index activation under fence, mobile qualification <=32 MiB, current-source full Fast and release. iOS physical qualification waived; test fixtures <=500 MiB. Best effort only.
