# Stage D14 — Windows native 1,000-note encrypted lifecycle and Desktop metadata latency

Date: 2026-10-23. Only isolated audit worktree; **not production/release approval**.

## Evidence boundary

The user authorized a real Windows Obsidian lifecycle on a disposable vault and GitHub repository plus actual slow/network-drive latency qualification, subject to existing 100 MB file cap. The machine reports **no mapped network drives** from `net use`. Accordingly the comparison here includes real local NTFS IO and **synthetic injected** per-`lstatSync` latency, **not a NAS/SMB/NFS acceptance result**. No production vault, master or GitHub Actions was touched.

### Native code under test

- Obsidian 1.14.4 Windows, same freshly built production `main.js` from integrated audit code (D13/13 warning policy B, D12 synchronous path protection and D11 WAL retain-backup). The source code is unchanged by subsequent test-runner-only commits.
- Actual Obsidian UI on uniquely named local vault and isolated Electron user-data-dir, two independent CDP ports, enforced vault-root equality before injecting the disposable GitHub credentials.
- Existing disposable remote repository numeric ID `1284153873`, `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform`. Credential input from ignored root `.env.github-e2e`; only the nonsecret pinned ID supplemented in ignored worktree `.tmp/d14-expected-repo-id.env`. The test rejects a protected or existing branch and always attempts verified absence cleanup.
- Reused/hardened the previously proven native driver from the original checkout in the isolated audit branch: `scripts/run-obsidian-live-github-ui.mjs`, `scripts/obsidian-live-ui-peer.mjs`, `scripts/obsidian-live-ui-mode.mjs`, `scripts/obsidian-live-ui-cleanup.mjs`, and its screenshot validator. Repaired obsolete `saveSettings(settings)` usage to assign `plugin.settings` then call `saveSettings()`. Replaced assertions referring to removed `progressSnapshot.diagnostics` fields with supported status, logical push counts and GitHub HEAD checks. A peer 1000-note restore receives a bounded 900-second CDP window; all ordinary peer cases remain 300 seconds.

## Measured synchronous filesystem cost

`node scripts/benchmark-desktop-metadata-latency.mjs` compiles the *actual production* `platform-io.ts` and runs 12 real staged replacements + proof-gated finalization per condition under a randomly created disposable worktree directory, verifying SHA/bytes and deleting fixtures afterward. `fs.lstatSync` intercepts only this synthetic run's path with a high-resolution synchronous busy-wait. Both baseline metadata calls and native `renameSync` operate on real local NTFS. No test fixture exceeds 24 bytes.

| Injected extra synchronous latency per lstat | Commit median | Commit p95 | Max event-loop delay | Actual total lstat time (144 calls) |
| --- | ---: | ---: | ---: | ---: |
| 0 ms (NTFS) | 6.338 ms | 10.773 ms | 15.860 ms | 1.427 ms |
| 2 ms (simulation) | 31.372 ms | 64.875 ms | 29.458 ms | 295.535 ms |
| 10 ms (simulation) | 127.845 ms | 168.171 ms | 131.531 ms | 1460.649 ms |

12 lstat calls per staged replacement on these paths, 2 native renames per replacement. Simulation is *not* a measured SMB latency distribution: busy waiting differs from OS network I/O, and the event loop monitor includes Windows scheduling jitter. It does show that synchronous metadata checks can substantially block the Electron renderer when metadata access becomes slow. Policy B preserves permission to sync with warnings and all hash/WAL/editor safeguards; it is **not** an assertion of UI smoothness or network crash durability.

## Real encrypted 1,000-note execution

First full run on audit test-driver commit `b10af99e21d3ca8065c4f2c9b3b4ccc652057ccf`:
- Encrypted remote configuration/ciphertext header/opaque logical names verified, Sync Center screenshot captured, zero observed UI exceptions.
- Synthetic nested Unicode create, rename/modify/delete, recreate journeys passed.
- The actual Obsidian vault created 1,000 bulk Markdown notes in **2,936.637 ms**. Encrypted upload/sync **success** in **293,623.7 ms** with logical Push 1,000/1,000. Remote GitHub HEAD changed, encrypted Git tree did not expose bulk logical paths, and warm 1000-note no-op ran in **2,415.5 ms** with no changes/no new GitHub commit. Warm small-vault no-op **1,857.3 ms**.
- **Peer not proven:** The separate Obsidian instance entered `downloading` with Pull total 1,003 but exceeded the original 300-second `Runtime.evaluate` timeout. The driver reported **FAIL**, not peer-pass. Remote branch was deleted and absence verified. Both managed Obsidian processes/vaults were cleaned up.
- This timeout is not evidence of GitHub rate-limit exhaustion. Read-only API quota check after cleanup: remaining **4,410/5,000** core requests. It is also **not proof of a product error**: the native driver timeout can occur before the product finishes.
- **Second run also failed the peer gate:** test-driver commit `325abf50bce92481089e642fe83c67a5735baf58`. Source Encrypted Push 1,000/1,000 succeeded in **315,849 ms**; warm no-op **6,998.9 ms**. Peer remained in `downloading` until the bounded **900-second** `Runtime.evaluate` timeout; no 1,003-file restore confirmation. Driver exited 1, remote branch cleanup **absent-verified**, zero recorded UI exceptions. Both native managed processes stopped.
- Live diagnostic probe inside the explicitly isolated peer found **830 HTTP requests**, **276,886,229 response bytes**, **0 retries**, and **no recorded HTTP 4xx/5xx/network failures** by 647 seconds, still downloading with 0/1,003 logical applies. A later timeout confirms major throughput/metadata repeat work, *not* a verified damaged remote object. This test uses real Obsidian 1.14.4 and a real disposable GitHub repository.

## Follow-up: redundant encrypted pack reads

Source analysis: `V4StorageCodec.preparePackFromSources` groups up to 500 small files into a shared authenticated encrypted pack. `V4SyncSession.stageRemotePull` used to ask `github.getFileBytes(record.remotePath, commitSha)` separately for **every pack member** (and re-decrypt for every member). Fail-first memory-backed 64-note regression demonstrated **64 pack downloads for a single encrypted pack**. It is consistent with the live 277 MB transfer volume, though not a packet-level proof of which bytes dominated.

Candidate optimization: `V4SyncSession.readRemoteRecordObject` caches the downloaded **ciphertext pack**, keyed by the immutable 40-hex-digit remote commit SHA, `packId` and object path, in the **existing per-session bounded V4ByteCache** (no extra unaccounted cache). A mutable or unpinned ref is never cached. Separate Sync sessions always re-fetch; over-budget packs are not cached; concurrent same-key reads are single-flight and failure never poisons cache. Each logical member is still independently AES-GCM decrypted, pack entry selected, plaintext SHA-256 and byte size checked by the unchanged codec, then staged under existing WAL/editor/containment gates.

Expanded regression verifies **1** fetch for 64 members sharing one immutable pack; a new session downloads again (**2** cumulative), and `maxCacheBytes:1` falls back to 64 additional fetches without changing bytes (**66** cumulative). Focused 87/87 and Recovery 79/79 passed on the candidate. A new **exact-commit native 1,000-note A→B** acceptance remains mandatory before calling this fixed; no remote protocol layout change.

## Remaining qualification

Actual controlled SMB/NFS or mapped drive timings, OS handle-relative no-follow TOCTOU, physical macOS/Linux/Android/iOS, C2 migration and line-level conflict UI are unqualified. Audit branch only, no release/tag/master updates.
