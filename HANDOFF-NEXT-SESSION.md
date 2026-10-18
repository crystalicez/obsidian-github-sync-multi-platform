# HANDOFF — NEXT SESSION

> Persistent handoff for the `obsidian-sync` project.
>
> **Mandatory workflow rule:** Every AI session that makes a material change to code, tests, design decisions, branch/PR state, verification status, or next steps MUST update this file before ending or handing work off. GitHub is the source of truth.

## 2026-10-18 live native Sync Center telemetry proof

- **Confirmed exact code SHA `f0fdcd2645408d9d15f1cbea21d5594683e5adee`:** clean detached `.tmp/sync-diagnostics-f0fdcd2-clean`, frozen install, real production plugin build, Obsidian.exe two fresh isolated vaults/profiles, disposable repo `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform` ID **1284153873**, branch `obsidian-sync-e2e/local-f0fdcd264540-08a10a5da3805b34`. `--mode=encrypted --verify-peer --journey --native-100mb --assert-diagnostics` **PASS / exit 0 / UI exceptions 0 / peerRestored=true / remoteEncryptionVerified=true / cleanup=absent-verified**, including combined rename/modify/delete/recreate/Copy conflict and 100,000,000-byte physical disk SHA-256 `f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8`.
- **Measured source native 100 MB upload run:** HTTP JSON/base64 request-body payload **133,345,016 bytes** / aggregate mutation request time **42,815.5 ms**, effective **2.97 MiB/s**; GitHub API **29 requests / 0 failures**, aggregate request time **46,806 ms**, average **1,614 ms**, worst **3,476 ms**. Measured content/path hashing **928.4 ms**; content encryption **87.7 ms**. Sampled Obsidian renderer RSS peak **338,239,488 bytes = 322.57 MiB**. These durations are overlapping subsets, not additive end-to-end durations. This is **one** run and NOT link-speed or comparative performance evidence. Uploaded file logical size 100,000,000 bytes; API JSON/base64 body is larger.
- **Important qualifier:** The source process's recorded **18,895 downloaded bytes** came from metadata/response bodies during the *upload* sync; that is **not** a 100 MB download throughput result. Added peer-instance instrumentation to the native CLI so a later run can capture actual Force Pull download bytes/time, decryption and peer RAM. **Peer-download figures not yet verified on new code at this checkpoint**; do not infer them from the source run.
- Test branch deletion was asserted by runner. Re-run independent read-only pinned-repository preflight on final test branches; do not claim verified twice before it passes. Keep `HANDOFF-NEXT-SESSION.md` as authoritative project memory, max 100 MB fixture, existing `tests/v4/github-transport.test.ts` user WIP unstaged; no release/merge.

## 2026-10-18 Sync Center per-run network and performance diagnostics

- **Maintainer request:** Add network speed and separate Upload, Download, Encryption, Hashing, GitHub API latency and Peak RAM to native Obsidian Sync Center. Treat `HANDOFF-NEXT-SESSION.md` in the real repository as the canonical project memory. Preserve the 100,000,000-byte maximum fixture. Use only pinned disposable GitHub repository ID `1284153873`; source and default branches remain protected.
- **Model/boundaries:** `src/lib/v4/run-diagnostics.ts` owns one in-memory run-scoped `V4RunDiagnosticsSnapshot`. GitHubClient records per-request JSON/raw **payload bytes** and `requestUrl` latency *inside scheduler execution* (not rate-limit waiting); average and worst latencies count failed responses. Effective payload MiB/s uses cumulative bytes divided by sum of request durations; it is **not** network link speed or an instantaneous wire-speed test. Crypto and hashing timings instrument the actual V4 codec tasks and incremental hash updates, including bounded disk source hashing; these are separate, overlapping work measurements, not additive phase durations. Renderer RSS peak is sampled at startup, 1 s intervals and API completions via optional Node `process.memoryUsage().rss`; `N/A` when inaccessible and never claimed as whole Obsidian RAM. No credentials, paths, URLs or content in diagnostics.
- **UI:** `src/views/sync-center.ts` Progress/Timings shows Upload API bytes/rate, Download API bytes/rate, number of GitHub requests, avg/max latency, measured Hashing/Encryption/Decryption, Peak renderer RAM, and interpretation disclaimer. New runs reset values; completed and failed runs retain their latest measured snapshot. Metrics live only in volatile progress snapshots, not GitHub or settings.
- **Tests:** `tests/v4/run-diagnostics.test.ts` validates exact payload rates, request timing/failures, split crypto/hash measurements, sampled RSS and inaccessible-memory fallback. `tests/v4/sync-center-progress.test.ts` validates visible rendered strings and disclaimer. Current working-tree build and **684/684 fast tests** passed; early fast RED from mock client without optional metrics method was fixed. Native `scripts/run-obsidian-live-github-ui.mjs --assert-diagnostics` now checks actual rendered API data, measured hashing/encryption, RAM and captures an evidence snapshot, including optional 100 MB run. **Do not mark actual native diagnostics GREEN before new clean-SHA live run and verified disposable branch cleanup.**
- **Preexisting user WIP:** `tests/v4/github-transport.test.ts` has unrelated unstaged changes; do not include it in commits. Source SHA and independent qualification must be recorded after commit. Other release gates (Android/iOS, hostile tree proof, mobile response buffering, hosted CI, independent review) remain open.

## 2026-10-18 real Obsidian multi-action conflict and 100 MB native qualification

- **GREEN clean committed code SHA `d9c409dd32fb5b21c24b186cb2305adcdebac78c`:** Independent detached `.tmp/native-journey-d9c409d-clean`, frozen pnpm install and production build, actual Obsidian.exe UI + GitHub REST with encrypted disposable branch `obsidian-sync-e2e/local-d9c409dd32fb-6cde8568a702bc09`. `--mode=encrypted --verify-peer --journey` ended **PASS, uiExceptions=0, remoteEncryptionVerified=true, peerRestored=true, cleanup=absent-verified**. Four verified stages: native create nested Unicode plus scratch → encrypted manual sync; rename + modify + delete combined → sync; recreate deleted file → sync; second *real Obsidian process* Force Pull validates contents and original-path absence, then edits same note remotely while local also changes; Copy policy preserved **both** independent texts. GitHub branch deleted after run, no user vault or default branch used.
- **Additional real-native max-file harness:** Optional `--native-100mb` requires encrypted mode and `--verify-peer`; writes exactly **100,000,000 bytes** with bounded 8 MiB filesystem writes **inside the fresh test vault**, checks actual Obsidian vault indexing, uploads through the real Obsidian V4 runtime to verified disposable GitHub branch, then second real Obsidian Force Pull checks its indexed file, physical size, and streaming SHA-256 equality. No larger fixture permitted. This option is **NOT YET RUN** at this checkpoint; do not call the 100 MB native gate passed before obtaining process exit code and remote branch cleanup proof.
- Running the expanded harness does not waive physical Android/iOS testing, restart persistence, hosted CI, or independent review. Original unrelated `tests/v4/github-transport.test.ts` remains unstaged and untouched.

## 2026-10-18 native Obsidian Windows user-journey qualification

- **Authorization / target:** User requests real Obsidian.exe with multi-action combinations against dedicated `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform` (pinned repository ID `1284153873`), using unique `obsidian-sync-e2e/local-*` branch per run. Keep this **actual** `HANDOFF-NEXT-SESSION.md` as repo's durable memory. Never use a real user vault; <=100 MB permanent fixture cap.
- **Actual native GREEN (code SHA `acef6d76daed90c7767a05783de2d0fe137fffca`):** On independent clean checkout `.tmp/live-e2e-acef6d7-clean` with actual Obsidian Desktop.exe isolated profile/vault, encrypted live GitHub Force Push, actual Sync Center **Sync now** after note edit, remote HEAD advanced, remote opaque AES-GCM blob checked, screenshot captured, then **second actual Obsidian process** Force Pulled and displayed decrypted exact note content. `--mode=encrypted --verify-peer` result **PASS / peerRestored=true / uiExceptions=0 / cleanup=absent-verified**. Its disposable branch was `obsidian-sync-e2e/local-acef6d76daed-696a7a000cfe5945`. No personal files involved.
- **Actual native plaintext GREEN:** Separate isolated real Obsidian executable with `--mode=plaintext` successfully published initial note, modified through Obsidian, clicked real Sync Center, confirmed head advanced and screenshot, with **PASS / uiExceptions=0 / cleanup=absent-verified**. Branch `obsidian-sync-e2e/local-acef6d76daed-e658a36200ae788a`. No cross-device plaintext restore was claimed.
- **Expanded user journey harness:** `scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --verify-peer --journey` now exercises native Obsidian Vault API create nested Unicode note and scratch file → manual sync → rename/modify/delete combination → sync → recreate deleted note → sync, second native Obsidian Force Pull verifying expected file bytes and absence of renamed original, remote edit from peer, then conflicting local edit and Copy reconciliation requiring both texts preserved. All actions are against the fresh synthetic vault; scripts clean up the branch and throw if the test fails. **This expanded journey has not yet been run at the time of this checkpoint**; do not call it green without final result.
- Screenshots live under the clean test checkout's ignored `.tmp/obsidian-live-github-e2e-evidence/`, not committed. Synthetic credential-bearing vaults/profiles are deleted after test completion. Native 100 MB Obsidian path, app restart continuity, hosted CI, mobile and independent audit remain open.

## 2026-10-18 final clean-SHA gate for approved live GitHub E2E

- Code/test/record commit **`acef6d76daed90c7767a05783de2d0fe137fffca`** was pushed to `audit/2026-09-26-production-hardening` after successful GitHub live tests. Detached independent checkout `.tmp/live-e2e-acef6d7-clean` matched this exact SHA and remained `## HEAD (no branch)` (no modified tracked files).
- In this clean checkout, `pnpm install --frozen-lockfile`, production build, **10 consecutive fast rounds × 680/680**, recovery **55/55**, resource **18/18**, feasibility **139/139**, soak **6/6** with max **100,000,000 bytes**, standard three-bundle GitHub E2E compile, metadata validation and package validation all exited **0**. The clean checkout contains the new live 96-file pack regression and corrected 16/32/50/100 MB variable-size assertions. These are offline/code-SHA checks, separate from the earlier user-approved credentialed GitHub runs.
- Actual GitHub results recorded immediately below: standard multi-device/copy/race **6/6**, encrypted 96-file packed (50,331,648 bytes) **1/1**, encrypted 16,000,000-byte disk roundtrip **1/1**, encrypted 100,000,000-byte disk stage-failure recovery **1/1**. Every branch `...a` through `...f` was subsequently checked absent using read-only pinned-target repo ID **1284153873** preflight. No plugin source repository, default branch or personal vault was mutated.
- Remaining release work: actual native Obsidian Windows acceptance at 100 MB, Android/iOS physical smoke, Git tree semantic integrity proof, network buffering/memory bound, hosted exact-SHA CI and independent review. No merge or release. User WIP `tests/v4/github-transport.test.ts` excluded from all staged commits and clean checkout.

## 2026-10-18 user-approved live GitHub REST E2E, pinned disposable target

- **Authorization and memory:** Maintainer explicitly authorized full **live testing against disposable repository numeric ID `1284153873`** and explicitly requires this **real repository's `HANDOFF-NEXT-SESSION.md`** as the canonical session memory. Continue to preflight repository ID, source-repository mismatch, default branch, and unique `obsidian-sync-e2e/local-*` branch before writes; verify post-run deletion. Never mutate the source/default branch or personal vault. All generated test file sizes stay **<= 100,000,000 decimal bytes**. No release/merge authorization.
- **Preflight:** Fresh branches `obsidian-sync-e2e/local-1314b2d-20261018a` (standard E2E), `...b` (initial 16 MB), `...c` (pack), `...d` (first corrected 16 MB), `...e` (GREEN 16 MB), and `...f` (100 MB) each passed read-only pinned-target identity and absent-branch verification before starting. Branches are confined to dedicated target.
- **Live GREEN pack:** New test `V4 encrypted GitHub packs round-trip 96 files within REST blob limits` in `tests/github-e2e/v4-real-github-e2e.test.ts` published **96 × 512 KiB = 50,331,648 bytes**, checked every logical record stored in shared encrypted pack blobs, ensured every remote pack Git blob is <= **8 MiB** and encrypted paths do not expose `Packs/`, then Force Pulled into a second synthetic device and compared every byte. Test **1/1 exit 0**, cleanup of `...c` confirmed. This is actual REST I/O through production V4 session, not offline simulator.
- **Live 16 MB GREEN:** `scripts/run-windows-100mb-github.mjs --bytes=16000000` passed real encrypted Force Push → no-op (same commit) → Force Pull and exact disk SHA-256 `78a620cb6358e837b2dd9e776c66cfdd3b98f5eb7a394b9a39c9472977447a47`, `1/1 exit 0`, `...e` cleanup confirmed. The first two earlier attempts on `...b` and `...d` **failed test-only assertions after successful content SHA equality**: below the 32 MiB whole-buffer ceiling, source whole-buffer hashing is allowed and multipart Force Pull may stage chunks even when the final mutation is a whole write. Updated the variable-size live test to assert bounded reads for >32 MiB, permit small-file hashing and temporary stage writes, and require correct final commit path. Both failed runs still confirmed branch cleanup.
- **Live 100 MB GREEN:** `scripts/run-windows-100mb-github.mjs --bytes=100000000` passed actual REST encrypted Force Push → no-op → deliberate bounded stage append interruption (no final target) → Force Pull retry → **100,000,000-byte** disk-file SHA-256 equality `f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8`. Source bounded reads **3**, staged writes **13**, test **1/1 exit 0**, branch `...f` cleanup verified. This is a Windows disk-backed synthetic vault, not a native Obsidian app test.
- **Independent branch cleanup verification:** Follow-up read-only pinned-target preflight on each branch `...b`, `...c`, `...d`, `...e`, `...f` returned **PASS / absent / default ref readable / 0 mutations** (all exit 0), independently of their test after hooks.
- **Standard GitHub REST E2E GREEN:** The three-bundle suite (compiled from the pre-pack-test code and current production source) completed **6/6 live tests, exit 0**, including plaintext/encrypted multi-device stale/copy/rename/delete-recreate/binary cases, protected reviewed conflict, out-of-band encrypted mutation denial, and controlled branch-head race. It reported cleanup of branch `...a`, then an independent read-only pinned-target preflight confirmed **absent**, default ref still readable, and zero preflight mutations. Runtime **872,989 ms** for the whole three-bundle live suite; the new pack test was separately compiled and run **1/1** against branch `...c` before this baseline completion. This is GitHub REST against synthetic vaults, not physical Obsidian.
- **Local checks:** `pnpm build` and `pnpm test:fast` **680/680** passed on the working tree after adding the pack test; E2E compile also passed. Recheck final committed test changes, record exact SHA and keep GitHub user WIP excluded. Remaining blockers are native-device acceptance, source Git tree semantic proof, transport peak memory, hosted CI, and independent review.
- **Scope:** Existing user WIP `tests/v4/github-transport.test.ts` remains unmodified and excluded from staging. Source GitHub tree semantic proof, mobile physical acceptance, native Obsidian 100 MB, transport memory, hosted CI and independent review remain production gates. Old-client compatibility is not a first-release gate.

## 2026-10-18 clean code-SHA qualification and read-only GitHub preflight

- **Code/test SHA:** `ac7c163aade3bab8105e61fb5f7d2185e1df70ab` was pushed on `audit/2026-09-26-production-hardening`. Detached independent `.tmp/firstrelease-keyring-clean-20261018` matched exactly and remained `## HEAD (no branch)` after qualification; the primary workspace user WIP `tests/v4/github-transport.test.ts` was not in this checkout.
- Inside the clean checkout, `pnpm install --frozen-lockfile`, build, **10 × fast 680/680**, recovery **55/55**, resource **18/18**, feasibility **139/139**, 100 MB-capped soak **6/6**, GitHub E2E three-bundle compile, metadata and package validation all exited 0. The test runner's known parallel isolation was also exercised. No hosted CI or native Obsidian 100 MB claim follows from these Node tests.
- A separate **read-only** remote identity preflight passed against pinned disposable GitHub repository ID `1284153873`. It confirmed readable default ref, absent namespaced candidate `obsidian-sync-e2e/local-readonly-ac7c163-20261018`, and **0 mutations**. This proves target identity and absence at the time of the read, not permission to create/delete a test branch.
- Release remains blocked by current-client live GitHub encrypted medium/pack, native Obsidian 100 MB and physical mobile acceptance, semantic Git tree publication proof, transport memory bounds, hosted exact-SHA CI and independent review. Older-client compatibility is **not** a blocker for this never-released plugin. No release, merge or credentialed write was performed.

## 2026-10-18 first-release policy and settings keyring retention

- **Maintainer decision:** This plugin has **never been released**. Do **not** treat compatibility with older installed clients or staged upgrade negotiation as a release blocker. New clients already write encrypted medium files (>8 MiB) using 8 MiB REST-safe chunks. Keep the current decoder's historical-format acceptance for now; it is useful for already-produced development data and does not require old clients to coexist. Do not gate production on cross-version capability handshakes. This decision supersedes older audit notes and handoffs, but does not waive current-code data integrity, encryption, recovery or physical device testing.
- **Confirmed RED:** Saving an unrelated UI/scheduling setting called `credentialsChanged()`, which incremented the keyring fingerprint and moved the still-valid derived keyring to a retired set. Each repeated save could derive another expensive PBKDF2 keyring and retain old key arrays until runtime disposal. A behavioral test showed a reference mismatch after a UI-only generation change.
- **Fix:** Separate settings-generation invalidation (always advances on a successful save) from key-context generation (advances only when owner/repo/branch, token or secret ID, mode, passphrase or secret ID changes). Unrelated settings changes retain the same derived keyring; credential changes still derive a fresh keyring. The settings transition still quiesces sync before publishing, and history/Force UI still rejects stale settings generations. This is not a change to on-disk encrypted data or GitHub protocol.
- **GREEN:** Focused settings **65/65** including actual `FastSync.saveSettings` UI-only versus passphrase rotation and cached key reuse. Production build, full fast **679/679** before the final integration test, final **10 consecutive fast rounds of 680/680**, recovery **55/55**, resource **18/18**, feasibility **139/139**, 100 MB-capped soak **6/6**, GitHub E2E three-bundle compilation, release metadata and package validation all exited 0 on this working tree. The results are not yet independent clean-SHA or hosted evidence. Independent clean-SHA, native app 100 MB, live GitHub medium/pack, mobile and hosted CI remain distinct release gates. No user-vault or credentialed remote mutations; unrelated `tests/v4/github-transport.test.ts` WIP preserved.

## 2026-10-18 poteto-mode Unicode local JSON byte-limit hardening

- RED reproduction found that stale or absent adapter `stat` can allow a local index header, shard, or integrity-valid recovery receipt with non-ASCII JSON to exceed the stated UTF-8 byte cap while remaining below the UTF-16 string-length cap. The index could trust a stale cached remote head; recovery could select an over-limit newer generation rather than the valid older receipt. Focused baseline failed **2 index assertions** and **1 recovery assertion** on the intended behavior.
- A shared, allocation-free UTF-8 size predicate now guards both persisted writes and post-read acceptance in `src/lib/v4/local-index.ts` and `src/lib/v4/recovery-store.ts`. It counts ASCII, multibyte BMP, supplementary-plane pairs, and malformed surrogates. Post-`stat` checks still reject a changed file after read, without allocating an extra byte buffer for size measurement. Original stat-before-read preflight remains.
- GREEN focused **8/8 index** (including exact UTF-8 boundary cases) and **5/5 recovery**. Full working-tree build, fast **678/678**, repeat **10 consecutive rounds of 678/678**, recovery **55/55**, resource **18/18**, soak **6/6**, feasibility **139/139**, three GitHub E2E bundles compile, metadata validation and package validation all finished exit 0. Soak uses at most **100,000,000 bytes**. These results are working-tree evidence, not a clean exact-commit-SHA or hosted run.
- No remote GitHub mutation, release, merge, production data operation, or old-client protocol change. The existing unrelated `tests/v4/github-transport.test.ts` WIP remains unstaged and untouched. Live GitHub pack/medium, native Obsidian 100 MB, mobile, old-client capability rollout, buffered response memory, Git tree semantic proof, and hosted review/CI remain open. Stat-before-read is not an atomic size-bounded file handle, so a racing filesystem replacement can still allocate before rejection.

## 2026-10-18 poteto-mode storage stat preflight

- Second RED → GREEN unit after JSON parser caps: Obsidian `V4LocalIndexAdapter.stat` size hint is wired through `runtime.ts` and validated before `read()`. A 67 KiB index header or 33 MiB recovery slot with reported over-cap size is now ignored **without loading its contents**. Recovery falls back to the last valid receipt. The source continues post-read guards when `stat` is not implemented or a file changes between checks.
- Writer validates UTF-8 encoded byte length and UTF-16 code units, so non-ASCII serialized data does not bypass the stat preflight contract. New tests cover Unicode, no-read preflight, oversize writes and older-receipt recovery. See `tests/v4/local-index-preparse-bounds.test.ts` and `tests/recovery/v4-recovery-preparse-bounds.test.ts`.
- The second unit's post-fix working-tree build, fast **675/675**, recovery **54/54**, resource **18/18**, soak **6/6**, feasibility **139/139**, E2E compile, package/metadata all exited 0. The dedicated stat preflight tests pass **5/5** index and **4/4** recovery.
- Read-only live GitHub preflight also passed: verified disposable repository numeric ID **1284153873**, default branch readable, absent namespaced test branch, **zero mutations**. No live qualification was run at this step.
- Live GitHub pack, native Obsidian current build 100MB, compatibility/capability policy, transport memory and Git tree semantic proof remain blockers. Original user WIP is not staged.

## 2026-10-18 poteto-mode local cache and recovery hardening

- Using the installed `agents-skills/poteto-mode` skill, applied RED/GREEN evidence to AUD-07. The old parser accepted oversized but structurally valid local index shards/headers and recovery slots, so stale cache or a newer oversized recovery generation could be trusted.
- `src/lib/v4/local-index.ts` now caps local header at **64 Ki UTF-16 code units** and each shard at **32 Mi** before `JSON.parse`; `src/lib/v4/recovery-store.ts` caps each slot at **32 Mi**. Writers also refuse output too large to load later. Invalid cache returns empty rebuild state; oversized recovery slots preserve fallback to the last valid generation.
- New focused tests under `tests/v4/local-index-preparse-bounds.test.ts` **3/3** and `tests/recovery/v4-recovery-preparse-bounds.test.ts` **3/3**. Entire working-tree build and fast **672/672**, recovery **52/52**, resource **18/18**, soak **6/6**, feasibility **139/139**, E2E compilation, package/metadata checks exit 0. These are not yet exact clean SHA evidence.
- Boundaries apply **after filesystem adapter read**, not to remote `requestUrl` buffering. Older-client chunk negotiation, Git tree semantics, keyring lifetime, 100 MB native-device and GitHub live current-SHA gates remain open. File test maximum remains 100 MB. Preserve `tests/v4/github-transport.test.ts` original WIP, no merge/release.

## 2026-10-18 comprehensive production audit clean-SHA qualification

- Audit code/test `642ecaacb469e01fac10ef57e19fb41d0c0bcda9` is pushed to audit branch, **detached independent** `.tmp/full-audit-clean-20261018` exactly at that SHA remained clean (`## HEAD (no branch)`).
- Frozen install, build, **repeat 10 × fast 670/670**, resource **18/18**, soak **6/6**, recovery **50/50**, feasibility **139/139**, GitHub E2E three-bundle compile, metadata and package validation all exited 0. This corroborates new 403 rights-vs-rate regression, but **no live credentialed GitHub mutation** took place during the audit.
- Source-guided risk-ranked report: `docs/engineering/comprehensive-production-audit-2026-10-18.md` (ten findings, including live/devices/CI/old-client capability gates). Unrelated WIP `tests/v4/github-transport.test.ts` remains uncommitted and excluded; Draft PR #8 not merged. 100 MB permanent test ceiling unchanged.

## 2026-10-18 comprehensive production audit, confirmed GitHub 403 bug, and native UI rerun

- Independently revisited V4 sync/upload/download/recovery, 8 MiB REST-safe parts/packs, legacy read compatibility, encrypted metadata, GitHub request scheduler/ref publication, platform I/O, keyring, Settings, Files read-only sidebar, Commit/History/Conflict/Force dialogs, CI/release and test infra. **Verdict: NOT production-ready.** Detailed prioritized audit: `docs/engineering/comprehensive-production-audit-2026-10-18.md`.
- **RED/GREEN defect:** `github-api.ts` treated a normal GitHub `403 Forbidden` with nonzero quota + `x-ratelimit-reset` as a rate-limit condition, retrying three times instead of failing permission errors immediately. Fixed to require true rate-limit evidence; secondary throttle with nonzero quota uses fallback rather than irrelevant primary-reset header. New `tests/v4/github-403-rate-classification.test.ts` **3/3** passes; source documentation: GitHub REST rate-limit guide.
- Working-tree post-fix `test:repeat` **10 × 670/670**, resource **18/18**, recovery **50/50** all exit 0; pre-fix full build, feasibility **139/139**, soak **6/6**, GitHub E2E compile, package/metadata checks all passed. New isolated Windows Obsidian native screenshot test (fresh synthetic vault/profile, **no credentials**) exited 0: **111 UI checks**, 0 JS exceptions, 375px Settings popout warning (only 175px content). UI screenshot runner safety tests **8/8**.
- GitHub connector confirms PR #8 remains **open Draft, unmerged**. No hosted Actions job success for current SHA established; connector's workflow-run search returns PR-event runs only. Current version historical native Obsidian 100 MB proof remains **pending**; old client forward compatibility when writing 8–50 MiB chunked, mobile physical qualification and GitHub real pack current SHA remain open. No 5GB tests.
- User WIP `tests/v4/github-transport.test.ts` deliberately untouched/unstaged. No merge, release, live GitHub mutation, credential logging, or user-vault access. A final clean exact-code-SHA regression run remains necessary after the audit fix is committed.

## 2026-10-18 clean code-SHA verification for medium REST-safe writer

- Audit code SHA `f8e2f724af11774a223952262b2b7d803a9be273` is pushed. Detached clean checkout `.tmp/rest-medium-clean-20261018` HEAD matches that exact hash and remained pristine (`## HEAD (no branch)`) after qualification. The original `tests/v4/github-transport.test.ts` remains unstaged only in the main workspace.
- Clean frozen install, production build, fast **666/666**, repeat **10/10 rounds x 666**, recovery, resource **15/15**, feasibility, 100 MB / medium 16/32/50 MB / historical encrypted 32 MB single-blob soak **4/4**, metadata/package validation, three usual GitHub E2E compiles and the new variable-size live E2E bundle standalone compile all **exit 0**.
- **No new credentialed GitHub 16 MB completed pull test on this SHA:** initial 16 MB live test failed due to fixture forbidding a valid <=32MiB whole write, safe branch cleanup verified; retry after fixing fixture was blocked by host safety checks. This is distinct from older successful real GitHub REST 100 MB test. Native Obsidian UI/device acceptance, hosted CI, independent review, and old-client forward-compatible rollout decision remain open. Details in `docs/engineering/v4-rest-safe-medium-writer-2026-10-18.md`.

## 2026-10-18 final clean exact-SHA REST-safe encrypted pack qualification

- Final **code + fixture SHA `fc414808fd94414c13c807ce306cc396681f9d8c`** is pushed to the audit branch. Independent detached `.tmp/rest-safe-pack-final-20261018` matches this SHA and has a clean detached status after qualification.
- Frozen pnpm install, production build, fast **667/667 ×10 repeat**, resource **18/18**, 100 MB-cap soak **6/6**, feasibility **139/139**, recovery **50/50**, package + metadata validation and GitHub E2E compile all exit 0. The pack regression physically encrypts/decrypts **96 × 512 KiB** input files via REST-bounded pack groups (no GitHub network).
- Production pack planner and both buffered/streamed pack writers bound each **new encrypted pack blob to <=8 MiB**, while old larger encrypted pack archives still decode. Direct oversized pack preparation fails before loading sources; same packet layout and reader format version retained.
- **Remaining release blockers:** credentialed real GitHub REST pack upload, host-native Obsidian acceptance, hosted CI and independent review, coordinated older-client rollout for separate medium-file chunk-format compatibility. No merge/release. Original `tests/v4/github-transport.test.ts` remains unstaged user WIP. Report: `docs/engineering/v4-rest-safe-pack-2026-10-18.md`.

## 2026-10-18 release artifact tamper test determinism

- While qualifying the new 8 MiB encrypted pack cap in a clean detached SHA, the first concurrently run Feasibility gate failed 1/139: the `local-release.test.mjs` hook called async `writeFile` without awaiting, racing tamper detection. This was a **flaky test fixture**, not proof the production release guard was bypassed.
- Switched that synchronous injected hook to `writeFileSync` (Node fs). Focused release tests **37/37** and complete Feasibility **139/139** pass. Build, fast **667/667**, resource **18/18**, 100 MB soak **6/6** and repeat **10 × 667/667** passed on the preceding code SHA. Final clean-SHA qualification completed at `fc414808` (see newest handoff entry).
- No merge, release, credentialed GitHub changes or unrelated WIP changes.

## 2026-10-18 V4 GitHub REST-safe new pack writer

- Audit found a **distinct oversize-path** after single-file 8 MiB caps: `planV4PackGroups` still admitted up to 32 MiB plaintext, which could become a JSON/Base64 encrypted Git blob much larger than 8 MiB. New pack planner now caps estimated **ciphertext bytes** to 8,388,608 including AES-GCM overhead. Both streamed and buffered pack creators fail closed on oversize before source read / serializing. **Historical pack readers remain unchanged**.
- Real offline codec regression: 96 × 512 KiB logical files (**50,331,648 bytes**, under permanent 100 MB test ceiling) grouped into REST-safe ciphertext blobs and all 96 recovered through production `readPackRecords`. Historical encrypted >8 MiB pack remains readable. Focused planner **5/5** and resource pack-stream **6/6**.
- Working-tree build, fast **667/667**, resource **18/18**, soak **6/6**, feasibility **139/139**, repeat **10 × 667/667** and GitHub E2E compile passed. Credentialed GitHub pack API test and exact committed-SHA qualification are separate gates. Preserve `tests/v4/github-transport.test.ts` WIP, Draft PR #8, no merge/release.
- Report: `docs/engineering/v4-rest-safe-pack-2026-10-18.md`.

## 2026-10-18 clean-SHA parallel test-runner qualification

- Audit code SHA `ff8933b5d2ed22a54d2c1bceece4918676aab9cb` was pushed. Detached `.tmp/parallel-runner-clean-20261018` matched the exact SHA and remained clean.
- Clean frozen install, build, **two simultaneous real suite runners**: `test:repeat` **10 × fast 666/666** and `test:feasibility` **139/139** (includes new concurrency regression); plus resource **15/15**, soak **6/6**, recovery **50/50** and GitHub E2E compile all passed. Cleanup check after tests: **zero orphan `.tmp/tests-*` directories**.
- Details: `docs/engineering/v4-parallel-test-runner-isolation-2026-10-18.md`. Original user WIP `tests/v4/github-transport.test.ts` untouched/unstaged. Remain Draft PR #8; no merge/release, no live GitHub mutation. Older-client rollout and native Windows Obsidian UI remain separate unapproved/unverified gates.

## 2026-10-18 parallel V4 test-runner output race fixed

- Previously `test:repeat` and `test:feasibility` could collide over shared `.tmp/tests`: real clean-SHA concurrent feasibility showed `ENOTEMPTY`, while sequential feasibility passed. Updated `scripts/run-tests.mjs` to allocate unique per-run `.tmp/tests-*` via `mkdtemp`, refuse linked `.tmp`, and perform per-run cleanup in `finally` without deleting preexisting shared bundles.
- Added permanent feasibility concurrency regression `tests/feasibility/test-runner-parallel.test.mjs`. It launches fast and feasibility subrunners simultaneously and confirms a sentinel in old `.tmp/tests` survives; targeted test **1/1 pass**.
- **Actual concurrent** Windows `pnpm test:repeat` (**10 x fast 666/666**) and `pnpm test:feasibility` (**139/139**) both passed. Inspection after both finished found **zero leftover `tests-*`** generated bundle directories. Build, resource **15/15**, soak **6/6**, recovery **50/50**, and GitHub E2E compilation passed. This is local working-tree evidence prior to code-SHA freeze, not hosted CI or live GitHub E2E.
- No secrets exposed, no user notes or GitHub branches touched, no release/merge; WIP `tests/v4/github-transport.test.ts` preserved. Report: `docs/engineering/v4-parallel-test-runner-isolation-2026-10-18.md`.

## 2026-10-18 exact-SHA legacy 48 MiB encrypted part proof

- Audit commit `c93438002cb70c48503ec3d4929620abc5890e03` contains historical 48 MiB AES-GCM part read-to-sink SHA integrity/tamper rejection and 8 MiB + 1 byte buffered writer regression. Independent detached worktree `.tmp/rest-legacy-48m-clean-20261018` at exact SHA passed frozen pnpm install, build, fast **666/666**, resource **15/15**, soak **6/6**, repeat **10 x 666**, recovery, feasibility **138/138**, metadata/package validation and GitHub E2E compilation; detached Git status remained clean.
- One **parallel test-runner collision** was found: feasibility versus repeat both rm/create shared `.tmp/tests`, causing `ENOTEMPTY`. Re-running feasibility alone after repeat passed **138/138**. A parallel-run isolation fix is pending; do not claim overlapping runners are safe. See `docs/engineering/v4-rest-safe-medium-writer-2026-10-18.md`.
- Legacy object read compatibility is proven on current client; **older clients still cannot be assumed to read newly written 8–50 MiB chunk records**. No native desktop release proof, merge, or release. Original `tests/v4/github-transport.test.ts` WIP untouched.

## 2026-10-18 legacy encrypted part compatibility follow-up

- Added the missing real cryptographic format proof for a **legacy 48 MiB encrypted part** inside a **50 MiB + 1 byte** logical fixture, decoded via the current V4 bounded sink. Validated full SHA-256, exactly two appended parts, old remote descriptor acceptance, and authenticated corruption rejection.
- Added **8 MiB + 1 byte** direct buffered V4 codec writer regression: two encrypted <=8 MiB payload parts and exact decrypted byte equality.
- Local cryptographic/real-file `pnpm test:soak` **6/6**, with all logical test payloads <=100 MB. This is *offline* data-format evidence, not a new live GitHub API run.
- Existing GitHub medium 16 MB Force Pull remains unverified after the harness issue/host safety denial; hosted CI, native Obsidian physical test, and cross-version rollout/capability negotiation remain blockers to release. Preserve original unstaged `tests/v4/github-transport.test.ts`.
- Details in `docs/engineering/v4-rest-safe-medium-writer-2026-10-18.md`.

## 2026-10-18 approved REST-safe medium 8 MiB writer threshold — implemented

- User explicitly approved **splitting new files above 8 MiB into 8 MiB max parts**, not just files over 50 MiB. New `shouldWriteV4Parts` is distinct from historical `shouldUseV4Parts`. Updated production `V4SyncSession`, buffered/streamed storage codec and remote descriptor validation. **Legacy single-blob records up to 50 MiB (with old encrypted-overhead rules) and legacy 48 MiB part descriptors remain accepted by current reader**. At exactly 8 MiB the writer may still use one object. Test files remain permanently capped at **100 MB decimal**.
- RED protocol tests then GREEN **6/6**; working-tree build, `test:fast` **666/666**, resource **15/15**, `test:repeat` **10/10**, recovery, feasibility, metadata/package validation, three standard GitHub E2E bundles and new variable-size E2E harness standalone compilation all exit 0.
- Working-tree `test:soak` **4/4**: real Windows disk-backed encrypted V4 16 MB (**2 parts**), 32 MB (**4 parts**) and 50 MB (**6 parts**) each Force Push → No-op → Force Pull → source/pulled SHA-256 equality; 100 MB (**12 parts**) plus staged-append failure and verified retry; historical **32 MB encrypted single** decrypted successfully. Virtual 100 MB cryptographic SHA-256 remains `f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8`.
- **Live medium E2E pending:** separate disposable GitHub 16 MB test sent Force Push/No-op but failed on the *test harness* attempting to prohibit a valid <=32 MiB whole-buffer destination write; disposable branch cleanup confirmed. Updated harness permits safe whole write <=32 MiB and uses staged failure injection only above32 MiB. New live launch was blocked by host safety controls. Do not claim 16 MB GitHub Force Pull passed. Prior 100 MB GitHub REST encrypted E2E pass used default 8 MiB chunks **before this medium threshold change**; not exact-current-SHA evidence.
- **Major rollout compatibility:** older V4 clients using the 50 MiB chunked minimum can **fail closed** upon seeing newly written 8–50 MiB chunked records. Coordinate an all-client upgrade or introduce capability/version negotiation before production. Older objects remain readable by this updated code; newer objects are not necessarily readable by older clients.
- Full report: `docs/engineering/v4-rest-safe-medium-writer-2026-10-18.md`. Preserve original unstaged `tests/v4/github-transport.test.ts`. No merge, release or user-data mutation; native Obsidian Desktop, hosted CI, and independent review remain open.

## 2026-10-18 real encrypted GitHub REST 100 MB and empirically safer writer

- **Actual GitHub E2E now passed:** Windows disk-backed synthetic source/target vaults on the production `V4SyncSession`, encrypted real GitHub REST Force Push → No-op → injected staged append interruption with no final target → clean Force Pull retry → full SHA-256 equality for **100,000,000 bytes**. SHA-256 `f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8`.
- Initial 48 MiB new chunked writer **failed real GitHub REST `POST /git/blobs` HTTP 422** (input too large). E2E-specific 8 MiB size passed, then production `selectV4WriterPartBytes` was updated to cap **new chunked parts at 8 MiB**, keeping the 48 MiB legacy reader/descriptor size. The E2E-specific workaround was removed and the full live scenario **passed again with production default 8 MiB**, 1/1 in ~103 seconds. Branch `obsidian-sync-e2e/local-100mb-20261018-932df8e` was **confirmed deleted** by safe cleanup after each test; default branch and source repository were untouched. Unreachable Git blobs are not guaranteed garbage-collected.
- A new purpose-built opt-in runner `scripts/run-windows-100mb-github.mjs` enforces a pinned numeric repository identity, a new namespaced branch, and cleanup. The offline disk-backed V4 100 MB encrypted soak also passes both normal and failure-recovery paths. Full evidence and limitations: `docs/engineering/real-github-100mb-rest-e2e-2026-10-18.md`; baseline separates live Node/REST evidence from **pending native Obsidian Desktop** physical qualification.
- **Compatibility decision intentionally NOT made:** old clients require chunked records to exceed the legacy 50 MiB threshold. Files/packs **below 50 MiB** still use old single/pack upload paths, which may have API input-size issues; changing their representation without coordinating protocol compatibility could break old clients. Keep as explicit production risk for maintainer decision, not an implied 1–100 MB acceptance claim.
- Current work is on audit working tree **before a frozen new code SHA**. Preserve original unstaged `tests/v4/github-transport.test.ts`, run deterministic exact-SHA gates after code commit, keep PR #8 Draft; no merge or release.

## 2026-10-18 clean code-SHA 100 MB qualification

- Code/test SHA `932df8e20a773fc59138808badb870de63542218` was pushed on the audit branch. Independent detached `.tmp/permanent-100mb-clean-20261018` had exact `git rev-parse HEAD` and pristine `## HEAD (no branch)` status **after** validation.
- Inside the detached checkout: frozen pnpm install, build, fast, resource (15/15), 100 MB cryptographic soak (1/1), and actual 100 MB Windows file write/copy/hash all exit 0. On-disk, copy and cryptographic-soak SHA-256: `f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8`.
- Working-tree repeat 10/10, feasibility, metadata/package validation and E2E compile passed earlier; an isolated repeat retry was refused at process capacity 17/16 and cannot be called an exact-SHA repeat result. Full live GitHub 100 MB encrypted Force Push/Pull **has not run**, as read-only preflight refused a missing pinned repo ID and a test branch outside the disposable namespace. No GitHub data mutation, merge or release.
- Clean details recorded in `docs/engineering/permanent-100mb-test-qualification-2026-10-18.md`; original `tests/v4/github-transport.test.ts` unstaged WIP remains untouched.

## 2026-10-18 permanent 100 MB-only tests and initial Windows evidence

- **Latest maintainer direction supersedes release-only scope:** All ongoing and future generated-file tests, virtual streams, soak and physical large-file tests must use at most **100 MB (100,000,000 bytes)**. No runnable 2/5 GiB soak/default is retained. Updated `scripts/run-soak.mjs` (strict >100 MB rejection), `tests/soak/v4-100mb-stream.test.ts`, `scripts/model-github-v4-large-file.mjs`, v4 benchmark/resource/feasibility/writer part fixtures and test discovery. The production sync engine was not limited to 100 MB.
- **Actual Windows filesystem only:** `pnpm test:windows:100mb` created and streamed two distinct physical 100,000,000-byte files inside a fresh `.tmp/windows-100mb-*` directory. Both SHA-256 digests matched: `f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8`. Report `.tmp/windows-100mb-Z9GCg0/report.json`. **This is not Obsidian/GitHub sync**.
- **100 MB cryptographic virtual soak passed** with matching SHA-256, 12 chunks, 2 planned parts, measured ~1.36 MB RSS delta. Focused policy 5/5 passed; fast 663/663, resource 15/15, feasibility, build, metadata/package validation and three E2E bundle compiles all passed from the original working tree. The first fast run failed only because test discovery referenced the renamed old soak filename; fixed and rerun green.
- **Remote preflight blocked without mutation:** E2E settings lacked `GITHUB_E2E_EXPECTED_REPO_ID`; optional command-line pin still found the configured branch outside `obsidian-sync-e2e/local-`. No GitHub branch was created/deleted/reset, and no credentialed 100 MB Force Push/Pull occurred. Before such a live test: confirm owned disposable repo numeric ID, isolated branch and actual file-backed bounded read/stage path (the existing `MemoryVault` E2E fixture is not equivalent). Current physical encrypted GitHub 100 MB round-trip baseline stays **pending**.
- Selectively commit/push only scoped files to Draft PR #8. Preserve pre-existing unstaged `tests/v4/github-transport.test.ts`; no merge/release. Full evidence: `docs/engineering/permanent-100mb-test-qualification-2026-10-18.md`. Clean exact-committed-SHA tests remain a separate qualification gate until rerun.

## 2026-10-18 maintainer decision — physical Windows release test capped at 100 MB

- **Final maintainer choice:** Test only **100 MB (100,000,000 decimal bytes)** as the physical Windows large-file release scenario; do **not** require a physical 5 GiB file. The Windows encrypted Force Push → no-op → separate clean-vault Force Pull → exact SHA-256 equality, observed bounded-memory measurements, and controlled recovery procedure still apply at 100 MB. **Physical 100 MB has not been run; baseline remains pending.**
- Updated `tests/baselines/v4/windows.json` physical-file `logicalBytes=100000000` and explicit decimal-size scope, `docs/testing/v4-windows-android-validation.md` including bounded PowerShell fixture generation, current release readiness, bilingual FAQ, and clean audit-SHA report. New `tests/v4/windows-release-size-scope.test.mjs` enforces the size, pending result, safe file creation, and the distinction between historical virtual 2/5 GiB tests and the current physical release gate.
- **Do not change** existing protocol limits, large-file guards, or historical virtual stress-test results because this is a release-qualification policy decision, not an instruction to remove code capability. Do not claim physical support above 100 MB based on virtual evidence. Android large-file support remains separately capability-gated.
- No real 100 MB GitHub upload, Force Push, or Force Pull was carried out without a verified disposable target and explicit authorization. Original unstaged `tests/v4/github-transport.test.ts` WIP must remain untouched; no merge or release.

## 2026-10-18 clean exact-SHA qualification — previously blocked gate now PASSED

- **Code SHA:** `4df548c31189d9864eff2a9b0fd9bf5fcda33ad1` in isolated detached `.tmp/e2e-retry-clean-20261018`; exact `git rev-parse HEAD` matched and `git status --short --branch` remained `## HEAD (no branch)` before and after qualification. This **supersedes the older 16/16 shell-capacity blocker** directly below. The main workspace's pre-existing unstaged `tests/v4/github-transport.test.ts` edit was not included.
- **Clean source test evidence:** `corepack pnpm install --frozen-lockfile`, `build`, `test:fast`, `test:repeat` (10/10), `test:recovery`, `test:resource` (15/15), `test:feasibility`, `validate:metadata`, `validate:package`, `test:github-e2e:compile` (three bundles) each finished **exit 0**. Native isolated Obsidian Desktop `node scripts/run-ui-screenshots.mjs --launch`: **111/111 checks, 22 screenshots, 0 JavaScript exceptions, exit 0**. Local report: `.tmp/e2e-retry-clean-20261018/.tmp/ui-visual-smoke/runs/1792300296417-27792/screenshots/report.json`.
- **Native UI warning:** the host Obsidian desktop Settings popout leaves only 175px for plugin content at a 375px viewport. The smoke check is **not physical mobile acceptance**.
- **Still OPEN:** full credentialed GitHub E2E including the intermittent controlled branch-head race, independent target cleanup proof, Hosted Actions CI (public workflows API reports CI active but no exact-SHA run), independent review, physical devices and release sign-off. This qualifies **audit code SHA only**, not `master`. No live GitHub writes, PR merge or stable release were performed. Detailed evidence: `docs/engineering/e2e-retry-clean-sha-qualification-2026-10-18.md`.

## 2026-10-18 E2E mutation retry hardening (after d367e60)

- **Pushed code/test SHA:** `4df548c31189d9864eff2a9b0fd9bf5fcda33ad1` was selectively committed and pushed to `origin/audit/2026-09-26-production-hardening`; GitHub REST confirmed PR #8 open, Draft, not merged, at that head. Staged diff contained exactly five intended files; `tests/v4/github-transport.test.ts` remains the only unstaged primary edit. GitHub Actions run and check-run queries each returned **0** for the code SHA. Detached `.tmp/e2e-retry-clean-20261018` checked out exact `4df548c31189d9864eff2a9b0fd9bf5fcda33ad1` and `git status` showed `## HEAD (no branch)`, but frozen install/clean exact-SHA tests **were not run** because shell tasks reported pool capacity `16/16` or `17/16` and alternate process launch was unavailable. Do not count checkout creation as clean-SHA qualification.

- **Confirmed E2E harness correctness defect:** `tests/github-e2e/v4-real-github-e2e.test.ts` used a generic HTTP retry helper for the Obsidian request bridge and external GitHub calls. It replayed `POST` and `PATCH` after 5xx or 429 even when the first mutation outcome was unknown; it also retried 401. A repeated mutation can distort race evidence. This is a test-harness finding, **not proof of a runtime mutation retry bug or a root cause for the previous intermittent race failure**.
- **RED→GREEN:** new behavioral `tests/v4/github-e2e-request-retry.test.ts` first failed 3/4 with literal `200 !== 503`, `201 !== 503`, and 401 retry count `3 !== 1`. Extracted `fetchGitHubE2EWithRetry` into `tests/github-e2e/support/request-retry.ts`: only `GET`/`HEAD` may retry HTTP 429/5xx; non-idempotent mutation responses and thrown network failures are never replayed. Six focused regression tests then passed **6/6**, including all four write methods and uncertain network outcome.
- **Observed primary working-tree gates:** `corepack pnpm build` **exit 0**, `test:fast` **exit 0**, `test:repeat` **exit 0 (10/10)**, `test:github-e2e:compile` **exit 0 (three bundles)**, `validate:metadata` **exit 0**, `validate:package` **exit 0**, `test:recovery` **exit 0**, `test:resource` **exit 0**, and `test:feasibility` **exit 0**. These are not isolated exact-committed-SHA proof. No credentialed live-GitHub mutation was attempted in this iteration.
- **Unchanged release blockers:** intermittent complete `controlled-external-branch-head-race` scenario still needs a fully logged live rerun and exact-SHA cleanup proof; hosted CI and independent review, real mobile acceptance, and maintainer PR approval remain open. PR #8 stays Draft. Original unstaged `tests/v4/github-transport.test.ts` WIP remains excluded. Evidence in `docs/engineering/github-e2e-request-retry-2026-10-18.md`. No merge or release.

## Active production audit — 2026-09-26

Branch: `audit/2026-09-26-production-hardening`
Baseline master: `ef4f8e675a0be7d598c22b2ce88c843c1306c926`

The user requested the most detailed practical production audit possible. This audit is active and must be resumed before declaring the repository closed again.

Audit method:
- prioritize data loss/corruption, cross-target mutation, fail-open protocol behavior, remote-input/resource amplification, crash consistency, credential/symlink/path safety, GitHub mutation ambiguity, cancellation, and concurrency;
- distinguish prior acceptance coverage from adversarial audit coverage;
- confirm each production candidate with a RED regression before changing behavior;
- use TDD for fixes;
- do not run destructive live GitHub E2E or `release:local` merely as audit verification.

### Confirmed production findings awaiting RED tests/fixes

1. **HIGH — local-index cache integrity is not content-authenticated before becoming remote authority.**
   - `loadV4LocalIndex()` checks that the persisted shard's `hash` string equals the header's advertised hash but never recomputes that hash from the loaded records.
   - A cached shard whose records are omitted/modified while its old `hash` field remains unchanged is still considered complete.
   - The plaintext unchanged-head fast path can reconstruct `V4RemoteState` from that cache without loading the immutable remote shard.
   - Consequence: Force Pull can treat a still-remote file as deleted locally; normal sync can also plan/publish from an incomplete remote record set and remove metadata/object reachability for an unrelated remote file.
   - Intended fix: recompute the canonical remote shard content hash from loaded cached records (excluding local-only cache fields such as `dirty`) and invalidate the cache on mismatch; retain the valid unchanged-head optimization.

2. **HIGH — settings/credentials can change while a sync is active, allowing cross-target state mixing.**
   - Setting UI currently assigns `plugin.settings = tempSettings` before `saveSettings()`.
   - `saveSettings()` invalidates keyring generation and replaces `githubClient`, but does not cancel/await the active coordinator run.
   - Runtime reads `this.plugin.settings` and `this.plugin.githubClient` repeatedly across awaits, so one run can observe repo/client/settings from different generations.
   - Consequence: state/config loaded from target A can be combined with repo identity/client/passphrase/policy from target B.
   - Intended fix: add a non-disposing coordinator/runtime quiesce operation; abort + await the active run while old settings/client remain installed, then atomically publish/store the new settings/client.

3. **HIGH — empty-repository bootstrap unknown outcome can silently adopt an unproven competitor commit.**
   - After a lost/unknown Contents bootstrap mutation response, `ensureGitRepositoryInitialized()` accepts any newly observed ref SHA as the bootstrap commit.
   - There is no proof that observed SHA was created by this invocation; a concurrent initializer can win in the unknown window.
   - Definitive 409/422 bootstrap races already replan correctly, but unknown-outcome bootstrap currently has weaker semantics.
   - Intended fix: if an unknown Contents PUT is followed by newly non-empty repository state, throw typed `V4RepositoryBootstrapRaceError` and replan rather than adopting the observed commit.

4. **MEDIUM/HIGH resource safety — encrypted remote config accepts unsupported/unbounded KDF semantics.**
   - `decodeV4RemoteConfig()` currently validates version/mode/path layout only.
   - Encrypted `algorithm`, `kdf`, `kdfParams.iterations`, and salt representation/size are not strictly validated.
   - Runtime passes remote iterations directly into WebCrypto PBKDF2.
   - Consequences: unsupported protocol fields are silently interpreted as current AES-GCM/PBKDF2 behavior; forged/corrupt configs can request extreme PBKDF2 work and cause CPU/resource exhaustion.
   - Compatibility note: tests/legacy fixtures intentionally use low positive iteration counts, so the fix should enforce recognized algorithms, positive-safe integer iterations plus an upper resource ceiling, and strict bounded base64url salt without imposing a new high minimum that breaks legacy repos.

5. **MEDIUM resource/protocol safety — history journal identity/page fanout is insufficiently bounded.**
   - Commit classification accepts any non-whitespace suffix after `obsidian-sync-v4:` as a journal ID, while the writer emits a restricted `${timestamp}-${base64url}` token.
   - Page 0 `pageCount` controls one remote read per page without a protocol ceiling.
   - Subsequent pages are not required to agree on `pageCount`; page change arrays are not bounded to the writer's 500-change default.
   - Consequences: forged/corrupt plugin-looking history commits can cause large request amplification and path-like journal identifiers.
   - Intended fix: validate journal ID token shape/length, bound page count, enforce positive integer page metadata/cross-page consistency, and cap changes per page to the writer contract.

6. **MEDIUM resource/protocol safety — remote record descriptors permit workloads the writer cannot produce.**
   - Remote record validation does not require non-negative safe `size`, bounded chunk part counts, or writer-compatible pack-entry sizes.
   - Chunked `V4StorageCodec.read()` currently fans all `partPaths` through `Promise.all()`.
   - Writer already enforces a 400 content-mutation/revision budget and pack limits (500 files, <=1 MiB entry, <=32 MiB plaintext group), but reader validation does not enforce corresponding impossible-state rejection.
   - Conflict/merge/copy/history paths use the whole-buffer reader, so forged metadata can amplify concurrent remote reads.
   - Intended fix: enforce remote record numeric/descriptor bounds using the writer constants and replace unbounded chunk `Promise.all()` with bounded/sequential reading as defense in depth.

7. **HIGH crash consistency — interrupted desktop stage replacement was not resumable from the backup-only state.**
   - Desktop atomic commit swaps `target -> <stage>.target-backup` then `stage -> target`.
   - A process crash between those renames leaves the target absent and the durable backup present.
   - Recovery previously evaluated the logical target precondition before delegating the large staged write to `commitStage()`, so this valid interrupted state could be classified as changed/replan-required instead of resumed.
   - RED coverage: `5a86244f21dac3d32e42e2cb330aee3356b52cc2`, `2c4de65ae99d2c558c9ac8845a7e08249deb6a8a`.
   - Fixes: `99f8e793c3270adbc0c9d48bfe7ec904f6f8c930`, `e2d9dae3bda454d0004b472aa6d54e687cc04a34` make desktop commit recover the backup-only intermediate state and let large recovery delegate the atomic precondition/recovery decision to the platform commit path.

8. **MEDIUM/HIGH memory safety — large chunked conflict-copy path could materialize the whole remote file before staging.**
   - Conflict-copy construction had a fallback `readRecord(...) -> stageBytes(...)` path.
   - For chunked content this defeated the streaming/staging design and could allocate the entire remote file in memory during a keep-both conflict.
   - RED coverage: `744c42ae289deb28ead5115f269317a3dff602c7`.
   - Fix: `d49bb3c8c38700aa7eec6a149b0b08d90e83a74a` routes chunked conflict copies through `stageRemotePull()`, retaining bounded streaming into staging.

9. **HIGH data loss — recovery replan cleanup could delete the only pre-sync backup after an interrupted desktop stage swap.**
   - If the process crashed after `target -> <stage>.target-backup` but before the durable recovery receipt, a later remote-head change could mark recovery `replan-required`.
   - Runtime then called `discardV4RecoveryStages()`; desktop `removeStage()` removed both stage residue and `.target-backup`.
   - In the backup-only crash state this could delete the only remaining copy of the local pre-sync target.
   - RED: `130fa31665b08728d7402f9967535cf2daa43508`, `77f283dbcf8c582c21c7bce569c12152b0cd5be9`, mobile contract `df79be819e5c5e2c6405b4931f01206c7ae52316`.
   - Fixes: `2e1251d06985a827086f970f1d48d5ab93eb673e`, `8d90ce599c152dfb076872a17968d781eca61dca`, `82987f41177ca4f927a30a9d6eb82d3e81419e23`, `d8fced6f4d79dafec9e59de29a58959c13fdc354`, `af293a38cc311b50bba9a731e8f60798353b0e17`.
   - Desktop rollback restores a verified backup when target is missing or still contains the staged bytes, refuses to overwrite unrelated user edits, and only then allows stage cleanup. Non-desktop rollback is a no-op because mobile never creates desktop target backups.

10. **HIGH — debounced local-change work could cross a settings/target generation even after active-run cancellation.**
   - The first settings fix cancelled/awaited the active coordinator run, but an old generation's debounce timer/pending queue could still fire after the new repo/client/settings were installed.
   - RED: `b0ac790970c6ac885dee48f8b235835c50584de7`.
   - Fixes: `a57fe29f03d3352640ad797b8d09a8598b764ed9`, `4b1897494ec2b24beabc8211f6b6ea719c5d2433`.
   - Coordinator now has reusable `cancelPending()`; settings quiescence clears old pending/timer state before cancelling the active run and again after idle, while leaving the coordinator reusable.

11. **MEDIUM privacy/correctness — Sync Center cached history service across settings generations.**
   - `V4SyncCenterView` retained one `V4HistoryService`, while that service captures GitHub client/config/keyring at creation.
   - After repo/token/passphrase rotation, subsequent history actions could continue reading the previous repository; an in-flight old history request could also complete after settings changed.
   - RED: `f49f2ee92ae6504db7f3d4b8a52a10b5da240df3`, `62d775dfd3675ef2c5ec73c8e466853eeac45360`.
   - Fixes: `634391f1e3ba167fe2559da0b2be9ece1a799e26`, `85ae7b944a401d278805bb03eb61238f76ed5f7a`, `4cb2eed2942b853e77ea7a237c00f5bd01c69e4b`.
   - Runtime exposes a monotonic settings generation, captures one client/repo/passphrase generation for history creation/file lookup, old history services assert their generation at async boundaries, and Sync Center recreates its cached service when the generation changes.

12. **MEDIUM/HIGH integrity — GitHub Contents 200 could bypass binary authentication when the response SHA was malformed.**
   - `getFileBytes()` only verified decoded Contents bytes against Git blob SHA-1 when the returned `sha` already matched the 40-hex pattern.
   - A non-empty malformed SHA therefore skipped verification and the decoded Contents payload was accepted directly.
   - This undermined the binary-transformation defense used for encrypted/opaque metadata and could propagate unverified bytes into protocol decoders.
   - RED: `7af7f593b634a445f88a469645874ed668138989`.
   - Fix: `934b7a979e0958ea8deb5907cf3594311dac0a2b` requires a valid Git object SHA before any 200 Contents payload can be trusted, verifies decoded bytes against that SHA, and otherwise falls back to the raw Git Blob endpoint using the validated SHA.
   - Fixture cleanup: current GitHub transport fixtures now use protocol-shaped 40-hex object IDs rather than symbolic placeholder SHAs where the Contents boundary is exercised.

13. **MEDIUM history correctness — strict V4 descriptor validation exposed that external Git history preview was using the V4 codec path.**
   - External commits produce raw Git tree/blob descriptors, not V4 storage descriptors with `pathId/plaintextSha256/remoteVersion`.
   - Reusing the V4 descriptor validator/codec for external history would reject those changes; on encrypted repos, attempting V4 decrypt semantics on an external raw blob is also conceptually wrong.
   - RED: `24e0d41a4aaf246992b045aca49fb226a79a4978`.
   - Fix: `91a81da29e06da35ea09886645bb07543717674e` routes external history previews directly through the immutable commit tree/raw Git blob while plugin-authored history continues through the V4 storage codec and descriptor validation.
   - Fixture cleanup: `7a2818d0c2bfdcae6eb70d39bf8b108c1aa71a98` keeps legacy remote-index fixtures protocol-shaped under the stricter validator.

14. **MEDIUM/HIGH integrity — raw Git Blob 200 responses were trusted without authenticating bytes against the requested object ID.**
   - Contents fallback intentionally treats the Git Blob endpoint as canonical, but `getBlob()` previously returned any 200 `arrayBuffer` directly.
   - A malformed/proxy-transformed 200 could therefore defeat the canonical fallback assumption.
   - RED: `6d324737c23a1e4fbde51f8bbd089c7a6ef48d16`.
   - Fix: `4f9b970f5db15fea65d91bcfc8e7140128e034cd` validates the requested Git object SHA, requires raw bytes, computes the Git blob SHA-1 over `blob <len>\0<bytes>`, and rejects mismatches or unavailable verification.

15. **MEDIUM resource hardening refinement — initial PBKDF2 ceiling exceeded the writer contract.**
   - The first KDF fix bounded remote iterations at 5,000,000, but the production writer emits exactly 600,000.
   - Accepting >600,000 preserved an avoidable remote CPU-amplification range the writer never creates.
   - RED refinement: `f07c06ee88bb5d5dc5f238292297dcfe2dacd4fb`.
   - Fixes: `c14ffb89b79aae4287f762fbd8d82a86e61facd5`, `b093ad1cebbb10b11d4202471c52a73e252bc5fc`, `4a03d7954859d63064bfc2ece5c88518fafe3232` define one shared exact 600,000-iteration writer/reader contract.

16. **MEDIUM fail-closed boundary — successful GitHub list/tree/object responses still accepted malformed object IDs/shapes.**
   - After initial response-shape hardening, refs/commits/mutation object IDs could still be arbitrary non-empty strings, and history list/tree responses could omit required structure such as the tree `truncated` boolean.
   - Malformed 2xx data could therefore move failure into later dependent operations or make history treat incomplete evidence as complete.
   - RED: `e05415043c61425897ba2c602d29e694a5c8159e`, `99bbd729d40cc9b08c1c79beb142b9ca0083d00b`.
   - Fixes: `751aeace07b7edf4bd226ed800ae11cc2ed5a4a8`, `8277a94652319e134bf0a304050ef76889d0895a` validate commit-list/tree shapes and require 40-hex Git object IDs at ref/commit/tree/blob mutation boundaries.
   - Fixture normalization: `28cc0e313c54757c930b96136a588af39c56c023`, corrected by `18c0509b9a8023de72e6f1794b30aae511091729`, keeps transport fixtures object-ID shaped without changing semantic `type: "blob" | "commit"` literals.

17. **MEDIUM destructive-action safety UI — Force Push/Pull confirmation understated the actual synced local scope.**
   - Confirmation counted vault files by excluding all `.obsidian/*`, while production scope can intentionally include config, bookmarks, community plugin metadata, and other plugins.
   - With those settings enabled, the destructive confirmation displayed fewer affected local files than runtime would actually consider.
   - RED: `50de3d3925e371001142b0b61f0b65ae9b32a0f6`.
   - Fixes: `d21c1c5d4a92d7875c4da6d185e78d39f4a774fa`, `111e9fdd0549f4f9de93753909eae1c6a3a085ba` centralize scoped-path counting on the same predicate used by runtime and use it in the force confirmation.

18. **MEDIUM settings safety — invalid ignore-regex edits could disrupt the current generation before being rejected.**
   - Scope compilation can throw for an invalid regex. If validation occurs only after runtime quiescence/settings publication begins, an invalid edit can cancel legitimate in-flight work or partially rotate runtime state even though settings are not accepted.
   - RED: `0fa5a74fe39259d117ecffc140b2ffadd76d3796`.
   - Fixes: `38928aa3aed4e51b82b4f23b65a3450544d7d946`, `3b6d46cb7c0d2d272021cacb59c851452a51625e`.
   - `saveSettings(nextSettings)` now compiles/validates the ignore regex before quiescing the old runtime generation, and the settings UI reports failure without publishing the invalid generation.

19. **MEDIUM remote resource amplification — chunk descriptors were broadly capped but not constrained to counts the writer can actually produce for the declared size.**
   - The first remote descriptor hardening allowed any positive part count up to 400.
   - A forged small or ~50 MiB record could therefore claim hundreds of canonical-looking part paths and trigger unnecessary immutable reads despite the writer using at least 1 MiB parts, at most 48 MiB parts, and not chunking below the threshold.
   - RED: `429b10ce5bc68bad0be548caf20b8826397759e3`.
   - Fix: `690f64ed557836caa3fb4923a833d7cb0e2d61e1` requires chunked records to cross the writer threshold and constrains part count to the writer-compatible range `ceil(size / 48 MiB) .. ceil(size / 1 MiB)`, while retaining the 400-mutation budget ceiling.

20. **MEDIUM/HIGH settings fail-closed regression — runtime validator existed but was not actually invoked before sync.**
   - `assertPluginSettingsRuntimeSafe` was added and settings-save validation called it, but `V4PluginRuntime.execute()` only imported the validator without calling it.
   - The existing RED contract in `tests/v4/settings-secrets.test.ts` explicitly required runtime validation before GitHub access; without execution, malformed persisted settings could still reach runtime work.
   - Fix: `d8fa4a6d9b7280fe4ca0a6076f579a281fbfc82d` invokes `assertPluginSettingsRuntimeSafe(this.plugin.settings)` immediately after cancellation check and before progress/network/session work.

21. **MEDIUM local destructive-replay safety — integrity-valid recovery payloads were not constrained to the writer contract.**
   - Recovery payload validation accepted arbitrary strings for mutation paths/IDs, duplicate IDs, completed receipts unrelated to any mutation, weak stage IDs/hashes/sizes, and incomplete/invalid target preconditions.
   - Plaintext recovery integrity is an accidental-corruption integrity check, not a keyed authentication boundary; coherent local state edits or programming bugs could therefore feed writer-impossible data to trash/write recovery replay.
   - RED: `96d07441114cdbeaf7a3737b7dff2a3daf91a0b2`.
   - Fix: `d9467e54517e1c357063acdfa4f256e1c92f3359` validates normalized vault paths, unique bounded mutation IDs, receipt subset/uniqueness, stage ID/hash/size/mtime, and exact target-precondition shape before loaded recovery state becomes replayable.

22. **MEDIUM invariant safety — unsafe recovery payloads could be replayed immediately after save without passing the load validator.**
   - `V4RecoveryStore.save()` returned the caller's payload in the snapshot and the sync path can apply that snapshot immediately.
   - Loader-only validation therefore did not protect the current process from an internal/upstream writer-contract violation.
   - RED: `722524c9abad4099f979fe59cd19d46b4da6fa3a`.
   - Fix: `2f2f1ac0875623279ff35362e82c097027504869` applies the same payload validator before persistence/return, so malformed recovery state cannot become replayable in-process or after restart.

23. **HIGH local-mutation safety — external Git paths were not normalized before entering reconciliation/planning.**
   - Manual/plaintext Git commits can introduce tree paths not emitted by the plugin writer, including backslash/noncanonical path forms.
   - Without an explicit trust-boundary check those paths could flow toward local pull planning with platform-dependent normalization semantics.
   - RED: `5a0409c06a3507f27fd1d15a2d220a33130e675d`.
   - Fix: `a42e50294fc3db66a30a4eaed69af56d84a9f291` requires every external non-internal blob path to pass `normalizeV4VaultPath` and already be canonical before any file read/planning/local mutation.

24. **HIGH conflict safety — external reconciliation synthesized remote mtimes and the `newer` policy treated them as authoritative.**
   - Git trees do not carry file mtimes, so reconciliation uses a local synthetic timestamp.
   - Under `newer`, a concurrent local edit could be overwritten merely because the synthetic remote timestamp happened to be later.
   - RED: `037845866387da48402e00ee5fe4528bee33c7be`.
   - Fix: `3433f06d1d31535a0adf57079e9193405a94382a` downgrades `newer` to keep-both/copy conflict resolution for externally reconciled state, preserving both sides instead of comparing synthetic time.
   - Follow-up `ae590080696312eeba0c5cf122cf32eb74bdc150` keeps synthesized external `remoteVersion` inside the protocol-safe token alphabet.

25. **MEDIUM fail-closed Git boundary — successful empty-repository bootstrap accepted a malformed commit object ID.**
   - Contents bootstrap `200/201` extracted `commit.sha` as any non-empty string, unlike the hardened immutable Git object APIs.
   - A malformed 2xx response could therefore trigger a dependent create-ref mutation using an invalid/unproven object ID.
   - RED: `fb8c8196c26a2be984defdb23d62c8acf9f11ca7`.
   - Fix: `95b56311885d9fbce55996e24afc3a593b355bd0` requires the bootstrap commit SHA to be a valid 40-hex Git object ID before any dependent branch creation.

26. **HIGH sync correctness — authoritative full scans trusted size+mtime and could silently miss content changes.**
   - The targeted watcher-change path already rehashes changed files.
   - Startup/scheduled/manual runs with no queued changes and explicit `rescan` used the full-scan path, where matching cached size+mtime reused the prior content hash.
   - Tools/restores that preserve both size and mtime could therefore change bytes while a normal authoritative sync continued to report no change and retained the stale index hash.
   - RED: `980f9211f2addc2d70cc83e071b82f419799f7c5` covers both no-change-list full scan and explicit rescan.
   - Fix: `f41c250c6f32a69244455b508423519079bb941f` disables stat-only hash reuse for authoritative full scans/rescans; targeted event-driven scans retain the optimization.

27. **MEDIUM settings lifecycle safety — malformed persisted settings could affect startup/client/timer policy before runtime validation.**
   - Runtime execution and settings-save boundaries were already validating settings, but `loadSettings()` installed migrated persisted settings before any validator ran.
   - `onload()` then used those values for GitHub client creation, startup-sync policy, scheduled-sync policy, and runtime construction before `V4PluginRuntime.execute()` could reject them.
   - RED: `d8a6c5eed4efe5eb50f46732f59106f5ae6d484e`.
   - Fix: `4319fb067755953613f95e218b206410b73627c2` validates the default-merged + secret-migrated settings object before assigning `this.settings`, preserving valid legacy secret migration while preventing malformed persisted safety controls from reaching startup policy.

28. **LOW/MEDIUM lifecycle safety — a late workspace layout-ready callback could recreate startup work after plugin unload.**
   - `onunload()` clears an already-created startup timer, but the registered `onLayoutReady` callback could itself run after unload and create a new timer that no later unload pass would clear.
   - The disposed runtime would reject/skip eventual work, so this was not a remote-corruption path, but it could retain a stale callback/timer after plugin disable/reload.
   - RED: `a01a7d2aa57908032bc0cccb72c8e76cbd3c660c`.
   - Fix: `90350f2f9afc18b5079b0b3dda3a6ad09f9def99` guards both the layout-ready callback and delayed startup callback with the plugin unload flag.

29. **HIGH remote-change detection — commit-message-only plugin classification could hide forged external content changes.**
   - When the branch SHA changed, sync previously treated the tip as a plugin publication solely when its first commit-message line equaled `obsidian-sync-v4:<current journalId>`.
   - An external commit could change plaintext user bytes, leave V4 head/shards unchanged, reuse the previous plugin message, and cause planning to see unchanged metadata and return no-op; the local index could then advance to the forged SHA without reconciling those changed bytes.
   - In encrypted mode, the same marker-only classification could hide an external object/tree mutation that should instead trigger the encrypted external-change fail-closed path.
   - RED: `556cb4c6f70bb2c70935857ce09c85a7e7ee95f0` covers plaintext reconciliation and encrypted rejection.
   - Fix: `4d1815e47d8a168753232d0d89cbe891126517f7` treats the message only as one signal. It also loads/decodes the immediate parent's V4 head and requires a valid publication transition: same mode, generation exactly parent+1, and a new journal ID. Otherwise the tip is reconciled/rejected as external.
   - Plaintext repositories intentionally cannot cryptographically authenticate a publisher: a repository writer can construct a fully protocol-valid plaintext publication. This fix prevents accidental/message-only masquerade; it does not claim publisher authentication where the protocol has no secret.

30. **HIGH protocol integrity — remote records could carry local-only cache flags.**
   - `V4IndexFileRecord.dirty` and `deleted` are local-cache semantics; the writer does not publish them.
   - Remote decode previously accepted them. In particular, `deleted:true` is filtered by `logical()`, so a forged remote record could be interpreted as an authoritative deletion even though the record still exists in the shard.
   - RED: `2ec65f85757b4ffca38983c216a36b986d652ef6`.
   - Fixes: `41a1e01d1fc91566673a5d96b229cc7e055189ae`, `be0af3b9e6f7df0dc2a4842acb2bb30983a1d8f0` exclude both local-only fields from canonical cache hashing and reject them at the remote record boundary.

31. **MEDIUM resource safety — packed-entry decoding allocated base64 payloads before binding them to the record size.**
   - Pack records carry an exact plaintext `size`, and the writer emits deterministic base64 length for each entry.
   - Reader previously called `fromBase64(encoded)` before checking encoded/decoded size, so a validly encrypted/corrupt archive could force entry allocation beyond the record contract before the hash mismatch was detected.
   - RED: `afe682d6282009ac50a9cbbc5191f08d6dca7132`.
   - Fix: `b4a3a1e2b883f4f45b3f162a9f4d992ac39371ee` validates encoded length from `record.size` before decode and decoded length afterward.

32. **MEDIUM availability safety — explicit GitHub rate-limit headers could bypass the configured maximum cooldown.**
   - `maxSecondaryCooldownMs` capped only the exponential fallback path.
   - A large `Retry-After` or far-future `X-RateLimit-Reset` could therefore suspend all shared request scheduling far longer than the declared policy maximum.
   - RED: `7eeef1371644cb592d0416137d1d17b3f8f4dde3`.
   - Fix: `bec76c2aa77ee3f42cc56dd6e6aa06300e647108` caps both explicit header-derived delays at `maxSecondaryCooldownMs`.

33. **HIGH settings consistency — failed settings persistence could publish a new runtime target/credential generation anyway.**
   - The first atomic-generation fix quiesced old work correctly, but then assigned `this.settings = nextSettings` before SecretStorage and `saveData()` completed.
   - A SecretStorage/persistence failure could therefore leave UI reporting “not saved” while the in-memory runtime/client had already switched; reusing the same secret IDs also meant a failed metadata save could overwrite credentials referenced by the old persisted settings.
   - RED: `b1ecad5cea161c01e9776b4a38c0a6d8cab8a951`.
   - Fix: `b9ebf4f33956d6535d625cffeb1b19eaac915689` allocates new secret IDs on credential rotation, stores/persists the prepared generation first, and only then publishes `this.settings`, invalidates the runtime credential generation, and rebuilds the GitHub client. A failed durable save may leave only unreferenced orphan secrets, not a hidden runtime/persisted target switch.
   - Test-contract cleanup: `362211c4c15f8729895a12068b1a8019357c6d56` updates source-order assertions to the transactional generation and repairs two malformed regex literals that would otherwise create false test failures.

34. **MEDIUM hardening-regression — strict remote-record validation initially rejected valid local cache records.**
   - Local index entries intentionally carry local-only fields such as `dirty:false`.
   - After remote wire hardening began rejecting `dirty/deleted`, unchanged-shard cache reuse still passed local cached records through the wire validator unchanged.
   - That would turn a valid post-sync cache hit into a failure even though the shard content hash was correct.
   - Closure discovery also found a stale `remoteV4StateFromLocalIndex` import left after the unauthenticated bypass helper was removed.
   - Fixes: `20b8a08f8e425581a0250b3c981325a56627728e`, `35bcb0b1a51a31d1275bf897502974f32fdb3429`, `5ee7e5aa19404e19feecac936f37187f9b8d3014`.
   - Local cached records are now projected into canonical remote shape (strip `dirty/deleted`) before remote validation/reconstruction, while GitHub-loaded records still reject those fields.

35. **MEDIUM resource/fail-closed boundary — Git tree blob entries without byte size could bypass History preview size checks.**
   - `getTreeAt()` allowed blob entries with `size === undefined`.
   - External history converted missing size to `0`, so the 5 MiB preview guard could pass before fetching an unexpectedly large blob into memory.
   - Current GitHub REST tree responses include byte size for blob entries; missing size is therefore malformed evidence at this boundary.
   - RED: `98fe2b8f636ceb5314ff3dab60d64cd90d85f71f`.
   - Fix: `5d9ad89d4717f3f3b81ed44d1d582edb8a76163c` requires a non-negative safe integer size on every `type:"blob"` tree entry before history/immutable-read consumers receive it.

36. **HIGH fail-closed reconciliation — immutable external tree evidence could be silently weakened when a listed blob read returned missing.**
   - External plaintext reconciliation first obtains a complete immutable Git tree and then reads each included blob at that exact commit.
   - The old path used `if (!file) continue`, so a tree-listed blob whose immutable read unexpectedly returned `null` was omitted from reconstructed remote state instead of treated as contradictory/incomplete evidence.
   - That could feed planning an artificial deletion/absence and allow later index/local mutation work to proceed from an incomplete external snapshot.
   - RED: `0ec71b2f5a6d1420728f60094bedf35b1380cb41`.
   - Fix: `52070098483524b029cca836d9e709060b88c38b` fails closed whenever immutable tree evidence says a scoped blob exists but its exact-commit file read is missing; the regression also asserts no local trash/delete and no index mutation occur.

37. **HIGH destructive-action safety — Force Push/Pull confirmation was not bound to the settings generation the user reviewed.**
   - The modal rendered repository, branch, and scoped local-file count from the settings/client generation current when it opened.
   - Confirmation later called `v4Runtime.forcePush()/forcePull()` without proving that settings were unchanged while the modal remained open.
   - A concurrent settings save could therefore make the user approve target A while the destructive operation executed against target B.
   - RED: `aef9f1149b60bfd16eaffbbbf7afa23f741e6aed`.
   - Fix: `dc4161bad4668d0686d019db11d07b87f273017f` captures `settingsGeneration` when the modal opens and refuses the destructive action if the generation changes, requiring the user to reopen/review the confirmation.

38. **MEDIUM lifecycle/cancellation safety — runtime decision modals were not abort-aware.**
   - Conflict and modification-threshold modals returned promises that stayed pending until user interaction.
   - Settings rotation calls `quiesceForSettingsChange()`, which aborts the active sync and waits for the coordinator to become idle. If an active run was awaiting either modal, the settings save could remain blocked until the stale modal was manually closed.
   - The first abort-aware modal fix also needed post-await canonical cancellation checks; otherwise an abort resolved to `ask`/false and could be reported as a generic sync failure.
   - RED: `25e473ae7d40f8ba740abc35ce5468215b83bbb8`, `95a0635e9a07702fcceb5d1da246935808b73b51`.
   - Fixes: `aa0f556aa1b9dfecfc82e2d0426a3939397892c5`, `cf88125803e3ce1c13199c82075235ef35c6036b`, `a8f4d79da344ba610ac83b4df2c20be4bfa571b0`.
   - Both decision modals now settle immediately on AbortSignal, remove listeners on every settle path, and callers re-check cancellation immediately after awaiting so settings change/unload remains canonical `V4CancelledError`.

39. **HIGH multi-platform path safety — logical paths were not restricted to a portable filesystem subset.**
   - Git and Unix-like vaults can contain names that Win32 cannot safely represent or aliases specially, including device names such as `CON.md`, trailing dot/space, control characters, and `<>:"|?*`.
   - Existing path normalization handled slash/dot-segments and sync separately detected NFC/case collisions, but did not reject these cross-platform-invalid path segments before remote/local mutation planning.
   - RED: `bcab23adc56f7edc8d5088159f519e4bff7ecf9c`.
   - Fix: `4b6282a559841d800a057caecf6ef096e95feca5` makes `normalizeV4VaultPath` enforce a portable logical-path subset: reject Windows device names, control/forbidden characters, trailing dot/space, and >255 UTF-8 byte path components.

40. **HIGH privacy/local-mutation safety — desktop filesystem IO could traverse vault symlink/junction ancestors outside the vault.**
   - Obsidian desktop supports symlinks/junctions that may target locations outside the vault. The previous bounded/staging IO resolved a lexical vault path with `getFullPath()` then used Node `fs.stat/read/open/mkdir/rename/rm`, which follows parent links.
   - A vault link to an external directory could therefore make local-source reads upload bytes outside the vault, or make staged pull/rollback/commit paths mutate files outside the vault.
   - External reference confirmation: Obsidian documentation explicitly warns that symlinks/junctions may point outside the vault and can cause sync/data-loss issues; FileSystemAdapter exposes `getBasePath()` and `getFullPath()` on desktop.
   - RED: `1f1052c4110f459f79dcae51e18183ea8418b90c` covers an external directory link used by bounded source read and a staged commit target beneath that link.
   - Fixes: `d6ddd9836e60b7ee7437656374decc30cbd93f3d`, `d25b9c0a9ccc92b051776da5ab4e41113f3939eb`, `d0e46ea1d8e4cd9bb75cd760a47fc8e1aea13ca1`, `10ad6688ca89061024095969247caed38ef98aef`, `4cb9a969ab8be2ebcbdc6beb85b88c020e444b58`, `7697ad51d8a32d1d4599c1bcfd4d6a7c2786a7ba`, `3ef3575af8ecc5eeb98f387efd76e003fc2dfe87`, `fb950b961bfa1fb43980dca5bc633374797151f7`.
   - Desktop IO now requires both FileSystemAdapter full-path and base-root proof, checks lexical containment, resolves the real vault root, rejects symlink/junction or outside-root existing descendants, and applies the guard to small vault reads/writes/trash plus bounded/staging/recovery IO. Desktop stage/recovery operations capability-fail rather than falling back to unproven adapter IO when root proof is unavailable.
   - The vault root itself may resolve through a symlink; links **inside** the vault tree are rejected for synced IO.
   - Residual TOCTOU: a local adversary/OS process can theoretically replace an already-verified directory entry between the guard and the following Node filesystem call. Fully eliminating that narrow race would require handle-relative/openat-style APIs not exposed by the current Obsidian/Node integration; do not claim stronger guarantees.

41. **HIGH settings-generation safety — new sync/history work could start during asynchronous settings persistence after the old generation had been quiesced.**
   - `saveSettings()` previously called `quiesceForSettingsChange()` and then awaited SecretStorage/plugin-data persistence before publishing the new settings/client generation.
   - During that persistence window the runtime was idle but not gated: watcher, manual, scheduled/startup, force, or history work could start again on the old generation. The save could then publish a new settings/client generation while that newly-started work was active, recreating the cross-target race fixed earlier.
   - Pending startup timeout callbacks were also not bound to the settings generation that scheduled them; an old startup timer could fire after a settings switch.
   - RED: `6a75dc8f4e8ca039709b08b75a1f9984c26efe7c`.
   - Fixes: `4b43edbe23a018c63dede004028d2a333d6d0275`, `2a31aff2789edfa55890f4483cce51cc26c201cb`.
   - Runtime now enters a settings-transition gate before cancelling/awaiting active work, blocks new manual/startup/scheduled/force/history work while the transition is active, cancels pending coordinator work, records in-scope local events for a post-transition rescan, and releases the gate in `finally` whether durable persistence succeeds or fails.
   - Startup and scheduled callbacks capture the settings generation that created the timer and no-op if that generation is stale.

42. **MEDIUM/HIGH credential/request-boundary safety — GitHub owner/repository settings could alter REST paths before repository identity checks.**
   - `GitHubClient.baseUrl` interpolates owner/repository into `https://api.github.com/repos/<owner>/<repo>`.
   - Branch/path/query components are encoded elsewhere, but owner/repository were free-form settings strings.
   - Malformed persisted or clipboard-derived values containing slash/query/percent/dot-segment syntax could therefore change the PAT-bearing REST path inside GitHub's API before normal V4 repository-identity validation ran.
   - RED: `c95c5ee000ed22d3097790785e35f6cd6e82545f`, `30d96a8c2098be66d85a931d1419fe0dfd1026ac`.
   - Fixes: `e06085a02108b534b3d1a88bac84e68828086b77`, `70d9359b97c051d539bdb81f05fdfdf252a75de1`, `0a897eed3b17f71bdb47bf5907adb6c9f2d21e80`.
   - A pure shared validator now restricts configured GitHub.com owner/repository coordinates to safe path-segment syntax; settings may still keep both fields empty while unconfigured, while direct `GitHubClient` construction requires valid non-empty coordinates.

43. **HIGH publication integrity — successful Git ref responses were not bound to the configured branch/target SHA.**
   - `getGitRef()` validated object SHA/type but accepted any non-empty `ref` string.
   - `updateGitRef()` and `createGitRef()` treated HTTP 200/201 as success without validating the returned ref name/object type/object SHA.
   - `publishV4CandidateRef()` returns immediately on a successful mutation call; reconciliation runs only when the mutation throws. Therefore a malformed/wrong 2xx response could make publication appear successful without proving the configured branch points to the requested candidate.
   - RED: `9422102bdc64c019890529852400b148f569f24c`.
   - Fix: `ef657ebc2ddeeec003e403279881127abefa71d8` centralizes configured-ref parsing and requires exact `refs/heads/<configured branch>`, `type:"commit"`, and exact requested mutation SHA for successful ref creation/update/read.
   - Fixture normalization: `8a9d29ab44713f5ee72733317a8f7c7b34ede63e` makes success fixtures reflect the actual GitHub ref response shape.

44. **MEDIUM/HIGH fail-closed Git evidence — recursive tree responses could contain duplicate logical paths and callers would silently choose/duplicate authority.**
   - `getTreeAt()` validated individual entries but did not reject duplicate `path` values in one tree response.
   - External reconciliation iterates every blob and could synthesize multiple records for one logical path; history converts tree entries to `Map(path -> node)` and would silently let a later duplicate replace the earlier one.
   - Immutable path-directed fallback already rejects duplicate exact entries, so accepting duplicates in the recursive boundary was inconsistent fail-closed behavior.
   - RED: `d6f4348979a876ae6c4aa83700b96028a719e124`.
   - Fix: `9c11d0a2b26566110d205c22d38b36e46a0359d8` rejects empty and duplicate tree paths before any sync/history consumer receives the response.

45. **MEDIUM/HIGH request-boundary safety — GitHub branch settings were not validated as safe Git refs before REST-path construction.**
   - Owner/repository coordinates already used a shared path-segment validator, but `githubBranch` was accepted as any string.
   - Branch is used both as a Git ref body value and in `/git/ref/heads/<branch>`; dot-segments, empty segments, `.lock`, `@{`, backslash/control/Git-special syntax could reach PAT-bearing REST requests before repository identity checks.
   - RED: `1b03b393a65ab4aa3c2d93763b3bf22de9716b9c`, `f49f664dd6bed74135a6aa3f01e28b4138be5b27`.
   - Fixes: `13eb57c1920abb1d04d0bc937a8f8bdfbb456efe`, `183b9d89ef52c14da102fc2a0b87b2b08d00b0c0`, `772f3d024c63b2f5c68d8f08efff06373cd864f1`.
   - Shared branch validation now rejects Git-invalid/dangerous ref syntax while preserving ordinary slash-separated branches such as `feature/local-release-qualification`; both settings validation and direct `GitHubClient` construction enforce it.
   - Compatibility correction: persisted/settings-layer `githubBranch: ""` historically means “use main” via the existing `githubBranch || "main"` fallback. RED `48e682490739b415cb75fc82a5ba76d576519383`; fixes `4a340753dfa0fb5e1780c3a4ab49ade6f458f536`, `7456e4e1321df1c87c5b0d98829e028066ccf902` allow empty only at the settings-validation layer while direct `GitHubClient` construction still requires a non-empty safe branch.

46. **MEDIUM/HIGH integrity/resource safety — whole-buffer V4 reads did not enforce the record's declared plaintext size.**
   - `V4StorageCodec.read()` verified plaintext hashes for single/chunked content but did not compare the returned plaintext byte length to `record.size`.
   - Conflict/history paths choose whole-buffer behavior partly from metadata size; a forged but internally hash-consistent record could under-report size and feed more bytes into a path the writer never produces.
   - Streaming `readToSink()` already enforced size, so behavior was inconsistent across readers.
   - RED: `90c19b14b2ff8385b392cc89c79023410ae6b49a`.
   - Fix: `b5d4af4091e23cfd2bdf5bbbce30375423db9608` requires actual plaintext length to equal `record.size` for single/chunked whole-buffer reads before returning bytes.
   - Residual transport limitation remains unchanged: Obsidian `requestUrl` can buffer an unexpectedly large HTTP body before this post-receipt validation runs.

47. **HIGH remote integrity — local-only cache flags were accepted on remote wire records and excluded from canonical shard hashing.**
   - Canonical shard hashing intentionally strips `dirty` / `deleted` because those fields are local-index cache state.
   - Fresh remote shard decoding nevertheless accepted those fields.
   - An external/corrupt commit could therefore add `deleted:true` to a remote record without changing the canonical record hash advertised by head metadata; planner logic filters deleted records and could treat a still-present remote object as logically deleted.
   - RED: `c0cb45d6c73bebe22a75ecd501a1d218a7dcf37e`.
   - Fix: `54b5d26c71286362add3aad8ab948ec152bfdf81` rejects any wire record carrying local-only `dirty` or `deleted` properties before remote shard records become authority.
   - Local persisted shards may still contain those fields; they are separately content-verified and protocol-validated before cache reuse.

48. **MEDIUM remote resource safety — aggregate pack groups were not constrained to writer limits.**
   - Per-record pack validation enforced <=1 MiB entries, but `assertV4RemoteRecordSet()` did not limit how many records could share one `packId` or their aggregate plaintext size.
   - The production writer caps a pack at 500 files and 32 MiB plaintext; accepting larger groups admitted remote states the writer cannot create and amplified repeated pack reads.
   - RED: `2f1a268e26f2a08e4c8b388cc203b67925fd2e45`.
   - Fix: `73dc49446e026de826000299201eddb9a6ff9a80` enforces `PACK_MAX_FILES` and `PACK_MAX_PLAINTEXT_BYTES` per remote pack group using the same writer constants.

49. **MEDIUM/HIGH remote resource safety — Force Pull decoded the same immutable pack once per member instead of once per pack generation.**
   - Packed records share one immutable encrypted pack object, but pull staging could call the single-record pack reader for every member.
   - A 500-file writer-valid pack therefore caused repeated download/decrypt/JSON/base64/hash work for identical bytes during one pull generation.
   - RED: `91d580b57093154a1a24eb9a63f78b00c92ba282`.
   - Fixes: `ec863a0d33ac4d8930a189b872442ed98a64a870`, `33349f1cad95c1f04e745b97fc4ce59dd8ef10f2`.
   - The codec now verifies/decrypts one declared pack group in a batch, and pull staging groups records by immutable commit + pack ID + remote path so a shared pack is fetched/decrypted once per pull generation.

50. **MEDIUM integrity/resource safety — pack payload bytes were not exactly bound to the declared record set before decrypt/JSON parse.**
   - Aggregate remote pack metadata was bounded, but the encrypted object itself could still contain extra/oversized archive entries not declared by the records being read.
   - The previous reader decrypted and parsed the whole archive before discovering missing/mismatched requested entries, allowing avoidable post-transport CPU/memory amplification and hidden undeclared archive content.
   - RED: `cfe0e5fabcb0545220da81ce6d18002a78a4a486` with compile-shaped fixture correction `386ad5286f21b9475b15371ee9e2940fcd07482a`.
   - Fixes: `9d78ea957fc66c9ed44846e1d7960577d7234f86`, `007bbb48612cb69f13d2bfed04eeebf5e330270f`.
   - Reader now derives the exact deterministic archive size from declared `fileId` + plaintext sizes, checks encrypted payload length before decrypt, re-checks plaintext archive length after decrypt, and requires the archive key set to equal the declared record IDs exactly.
   - This does **not** remove the previously documented transport peak-memory residual: Obsidian `requestUrl` can still buffer an unexpectedly large HTTP body before post-receipt validation runs.

51. **LOW/MEDIUM reliability — scheduled sync timer could be enabled before GitHub configuration was complete.**
   - `shouldRunScheduledSync()` checked only `syncEnabled + scheduledSyncEnabled`, unlike startup sync which also required token/owner/repo.
   - Main then installed a repeating timer whose callback invoked `runtime.scheduledSync()` without a local catch; runtime throws when `githubClient` is absent.
   - A partially configured installation could therefore produce repeated rejected scheduled sync attempts every interval.
   - RED: `d36678c39c1570821a073c086c56d4c147bc29eb`.
   - Fix: `8b5d2ff83e7d4528b7f606ce6a9b1b97de9c2647` makes scheduled sync require the same complete GitHub configuration predicate before a timer is created.

52. **HIGH integrity — a matching remote commit SHA did not prove the local cached shard manifest matched the authenticated current head.**
   - A local index could remain internally self-consistent and retain the same `remoteCommitSha` while its epoch/generation/shard-hash manifest disagreed with the current remote head.
   - The remote loader correctly fetched authoritative remote records, but planner base selection previously treated cache completeness + a remembered commit SHA as sufficient known-base authority.
   - That could let stale/tampered cached records influence causal planning even though the current remote head had already disproved the cache manifest.
   - Fix: `82efe37c23094d20aeb348a2f93be7b1ede50a38` requires mode/epoch/generation and the complete shard-hash manifest to match the authenticated current head before cached records can be used as the known base.
   - Regression coverage: `v4 plaintext matching-SHA sync rejects a self-consistent local cache that disagrees with the remote head`.

53. **HIGH correctness/reliability — a large keep-both conflict copy could consume its stage before the corresponding push read it.**
   - In the no-recovery execution path, committing a large staged pull moves/removes the stage file as it becomes the final vault target.
   - The paired push for an in-scope conflict copy could still retain a stage-backed source handle, so later upload preparation attempted to read a stage that had already been consumed.
   - Fix: `82efe37c23094d20aeb348a2f93be7b1ede50a38` tracks consumed pull stages and rewrites any paired push source to the committed vault file with the same hash/size/mtime snapshot.
   - The large keep-both regression now uses a writer-shaped chunked remote object and verifies the committed copy without whole-buffer reassembly.

54. **MEDIUM/HIGH audit-branch correctness regression — exact pack validation initially rejected writer-valid multi-entry packs in single-member consumers.**
   - The new exact pack payload/entry binding in `007bbb48612cb69f13d2bfed04eeebf5e330270f` is correct only when the reader receives the complete metadata group for that immutable pack.
   - Sync conflict/pull paths and history preview still had call sites that supplied only one packed record; after rebasing the audit branch, writer-valid multi-member packs therefore failed with `V4 pack payload size does not match its declared records.`.
   - Fix: `932515b` threads complete pack metadata through pull/conflict bindings, makes historical pack preview load and validate the historical V4 state before decoding, and falls back from unknown-base three-way merge when an older packed base cannot be proven complete.
   - The strict payload-size and exact archive-entry-set checks remain intact; this repair does not weaken finding 50.
   - This regression was caught on the audit branch before merge/release.

55. **MEDIUM remote resource safety — file-history traversal had no aggregate journal page-read budget.**
   - Per-commit journal validation capped one journal at 256 pages, but `getFileVersions()` can scan up to 20 commit-list pages × 50 commits.
   - A history made entirely of valid plugin markers with writer-limit journals could therefore drive roughly 256,000 journal-object reads for one file-history request even though every individual commit was protocol-shaped.
   - RED: `ee6640d6fe02f9e493158f3c60e30e026fbd6948` proves aggregate fanout was unbounded across otherwise valid commits.
   - Fix: `45123da` gives one `getFileVersions()` traversal a shared 1,024-page journal-read budget and decrements it before each remote page fetch. Single-commit history inspection retains the existing per-journal 256-page contract.

56. **LOW/MEDIUM reliability — scheduled sync intervals could exceed the signed 32-bit timer delay range.**
   - Runtime settings accepted any positive finite `scheduledSyncIntervalSeconds`; normalization enforced the 30-second minimum but no upper timer bound.
   - Extremely large but otherwise valid values were multiplied by 1,000 and passed to `setInterval`, where timer implementations can overflow/clamp an out-of-range delay into unexpectedly frequent execution.
   - RED: `ee6640d6fe02f9e493158f3c60e30e026fbd6948` shows `Number.MAX_VALUE` survived normalization unchanged.
   - Fix: `45123da` clamps normalized intervals to `Math.floor(0x7fffffff / 1000)` = 2,147,483 seconds while preserving the existing default and 30-second minimum.

57. **MEDIUM reliability/resource safety — large local-event bursts could overflow JavaScript argument limits during debounce coalescing.**
   - `coalesceV4Changes()` used `Math.max(...changes.map(...))` for rescan mtimes and ambiguous rename fallbacks.
   - A 150,000-event burst reproduced `RangeError: Maximum call stack size exceeded` on the repository's Node 24 toolchain before sync execution began.
   - Vault watchers can accumulate very large event bursts during mass operations, so sync reliability must not depend on the engine's function-argument count limit.
   - RED: `8aac1d5bc0b7598dafd25e4302be4035e960ff08`.
   - Fix: `e1173260c083c2be55c4317ed1fec119b90a488f` replaces spread-based maxima with one O(n), O(1)-extra-space scan in every coordinator rescan-mtime path.

58. **MEDIUM remote protocol/history safety — journal change objects were exposed before writer-shape/path/descriptor validation.**
   - The history reader bounded page count and changes-per-page but accepted arbitrary individual change objects from remote journal JSON.
   - Invalid change kinds, unsafe/non-canonical paths, and impossible create/delete/modify/rename shapes could escape `getCommitChanges()` into Sync Center/history consumers before preview-time descriptor validation.
   - RED: `8aac1d5bc0b7598dafd25e4302be4035e960ff08`.
   - Fix: `e1173260c083c2be55c4317ed1fec119b90a488f` validates every decoded journal change at the read boundary: kind, portable paths, writer-shape semantics, and before/after descriptors through the existing V4 remote-record contract. Rename-before descriptors are validated against `previousPath` rather than the new path.
   - One older test fixture represented `modify` with only `after`; the initial V4 writer history was checked and the fixture was corrected to the writer-valid before+after shape instead of weakening production validation.

59. **HIGH immutable Git integrity — successful commit/tree reads were not bound to the requested object IDs.**
   - `GitHubClient.getGitCommit(requestedSha)` and `getTreeAt(requestedTreeSha)` validated that returned SHAs were syntactically valid Git object IDs, but did not require them to equal the immutable IDs named in the request URL.
   - A mismatched 200 response could therefore substitute a different valid commit or tree into publication reconciliation, external-commit reconciliation, Force Push tree evidence, immutable fallback, or history preview logic.
   - This was inconsistent with raw Git Blob reads, which already authenticate returned bytes against the requested object SHA.
   - RED: `1c5ca913938a2df2b8c9a034e21669197531d62f`.
   - Fix: `8d56b55c130062934ed3850b43dfcb62b462bb69` validates requested commit/tree IDs before issuing the request and rejects any successful response whose object SHA does not exactly match the requested immutable ID.

60. **HIGH immutable Git mutation integrity — successful blob creation was not bound to the uploaded bytes.**
   - `createGitBlob()` accepted any syntactically valid SHA returned by a 201 response and handed that SHA to tree construction.
   - A mismatched success response could therefore make a candidate tree reference different blob bytes from the content that the client actually uploaded.
   - RED: `e4c68da4e8f37af14ac1add9a715db201b5f30e0`.
   - Fix: `7cc635aa3ee71bdbe36ddce8a6d7b5017c895f27` computes the deterministic Git blob SHA from the uploaded bytes before the base64/HTTP transient reservation and rejects any successful mutation response whose SHA differs. Existing transport fixtures were updated to use the real Git object IDs of their uploaded bodies.

61. **HIGH publication integrity — successful commit creation was not semantically bound to the requested message/tree/parents.**
   - `createGitCommit()` previously accepted any valid-looking SHA from a 201 response; candidate publication could then update the branch ref to that unrelated commit.
   - RED: `1192a6c12c3900f87290f38a3702e8c4876d2b64` returns a valid created SHA whose immutable commit has a different message and proves the mismatch was accepted.
   - Fix: `ddec918b51d3dc4e0129449b0682487cce1fb126` validates requested tree/parent object IDs, reads the returned immutable commit back by SHA, and requires exact message, tree, and ordered parent-list equality before the SHA can become a publication candidate.

62. **HIGH bootstrap integrity/race safety — a successful empty-repository Contents bootstrap could silently adopt a competitor base.**
   - The empty-repository preflight and Contents PUT are separate operations. If another initializer created the default branch after the preflight but before our PUT, GitHub could accept our PUT as a child commit on that newly created branch.
   - The previous success path trusted the returned commit SHA and could then accept/create the configured ref at that child commit, thereby inheriting competitor state despite the operation having been planned as an empty-repository bootstrap.
   - RED: `e042790b06fbce6621054a4ab67b3edbdcb6a855` models a successful bootstrap response whose immutable commit already has a competitor parent.
   - Fix: `a4f9d5ba5ecd26140cb3a237251aa96939783276` reads the successful bootstrap commit immutably before any configured-ref adoption, requires it to be a root commit with the exact bootstrap message, and surfaces a typed `V4RepositoryBootstrapRaceError` carrying the observed parent SHA when a competitor base is present.

63. **HIGH bootstrap mutation integrity — root/message checks still did not bind the successful bootstrap commit to the exact marker bytes requested.**
   - After finding 62, a returned bootstrap commit had to be a root commit with the exact bootstrap message, but a different root commit carrying that same message could still be accepted if its `.obsidian-github-sync-v4/bootstrap` bytes differed from the Contents PUT body.
   - That left another substitution gap in the successful empty-repository bootstrap path before configured-ref adoption.
   - RED: `26af58a088acca4f39568a645c1e0e00225a7a26` returns a root commit with the exact bootstrap message but different marker bytes and proves the success path previously accepted it.
   - Fix: `ff4386adeb24f983316872ae99394464b17efad3` reuses the exact bootstrap bytes sent to Contents PUT, reads the marker back immutably at the returned commit SHA, and requires byte-for-byte equality before accepting or creating the configured ref.

64. **HIGH bootstrap ref-adoption integrity — a configured branch appearing after verified bootstrap could be accepted at a competitor SHA.**
   - After the root bootstrap commit and marker were verified, `ensureConfiguredBootstrapRef()` returned any already-existing configured branch without requiring it to point at the verified bootstrap commit.
   - A competing actor could therefore create the configured branch between bootstrap verification and configured-ref adoption and cause the caller to continue from unrelated state.
   - RED: `103bae04cdebc751d8dd5b367b6e774141291ad8`.
   - Fix: `68803e2f8ef1754c5c16dd93cce524f0dae84551` centralizes configured-bootstrap-ref validation and raises a typed `V4RepositoryBootstrapRaceError` unless the observed branch points exactly at the verified bootstrap SHA.

65. **HIGH bootstrap ref-race safety — a configured branch could move away immediately after successful ref creation.**
   - The successful `createGitRef()` path re-read the configured branch and returned it without binding that re-read to the bootstrap SHA.
   - A competitor advance between ref creation and the follow-up read could therefore make bootstrap appear successful at a different commit even though the create response itself was correct.
   - RED: `d5cdcd2ecd0424bfc6bff2be0f665a0d8ee79e19`.
   - Fix: `68803e2f8ef1754c5c16dd93cce524f0dae84551` applies the same exact-SHA bootstrap-ref assertion to the pre-existing, post-create, and ambiguous-create reconciliation paths.

66. **LOW/MEDIUM qualification reliability — the fast-tier planner benchmark used wall-clock time under concurrent test load.**
   - The 100,000-file planner regression asserted `Date.now() - started < 5_000` while Node's test runner executes fast-tier files concurrently.
   - On the current branch this reproduced a false full-suite failure: functional assertions passed, but the planner test observed ~8.4 s under CPU contention; an immediate isolated rerun passed all 3 benchmark tests with the planner at ~1.13 s.
   - Fix: `0762038ae20673674fceb71376906dd21d1443c4` keeps the same 5-second compute budget but measures the benchmark process's own CPU time via `process.cpuUsage()`, excluding scheduler wait caused by unrelated concurrent test files. A subsequent full fast run passed 503/503 before the next regression was added.

67. **HIGH bootstrap tree integrity — exact bootstrap marker bytes did not prove the root commit contained only the requested bootstrap tree.**
   - After finding 63, a substituted root commit with the exact message and exact marker bytes could still contain additional root or bootstrap-directory entries and be accepted before configured-ref adoption.
   - RED: `2d3812e6b5010c8296242ac3b5df8c9b2f86394b` supplies the exact marker plus an extra root `extra.txt` and proves the success path previously accepted it.
   - Fix: `593657cb7a73b06630a0610f38ba281ea2eaa883` authenticates the bootstrap commit's non-recursive Merkle shape: the root must contain exactly the `.obsidian-github-sync-v4` tree, that tree must contain exactly the `bootstrap` regular blob, and the leaf SHA/size must match the already authenticated marker. This is a bounded two-level proof and does not add a recursive repository scan.

68. **HIGH immutable Contents identity integrity — authenticated blob bytes were not bound to the requested repository path/type.**
   - `getFileBytes(path, ref)` authenticated a successful Contents payload against the response blob SHA, but accepted that authenticated blob even when the successful response described a different repository path.
   - A malformed/substituted Contents 200 could therefore return valid bytes for another file and pass the blob-integrity check; the immutable fallback's path-directed Merkle proof only ran on 404 and did not protect this 200 path.
   - GitHub's Contents file schema includes both `type: "file"` and the requested repository `path`, so this identity can be checked without inventing a new protocol rule.
   - RED: `79a109603463a56559982d0c071df662db95e2be` returns a byte/SHA-authenticated blob for `different.md` while requesting `expected.md` and proves the response was previously accepted.
   - Fix: `d957ad1` requires a successful Contents object to be `type: "file"` and to report the exact requested path before decoding/trusting its payload. SHA validation remains first so malformed-object-ID failures retain their established precedence.
   - Fixture follow-up: `a121304` makes the immutable-fallback success fixture protocol-shaped rather than weakening the new production boundary.

69. **HIGH bootstrap availability/compatibility — configured-ref lookup rejected GitHub's documented empty-repository HTTP 409.**
   - GitHub's Git database REST documentation lists `409 Conflict` for Git reference reads and states that Git database APIs return 409 when a repository is empty or temporarily unavailable; empty repositories must be initialized through the Contents API.
   - `getGitRefOrNull()` converted only 404 into an absent ref. A real empty repository could therefore fail before reaching the already-hardened Contents bootstrap path.
   - RED: `d578693148d77549a7a3aab779a580daf073345b` reproduces a `Git Repository is empty.` 409 from the configured-ref endpoint and proves the helper threw instead of returning `null`.
   - Initial fix: `6d3ba0a899214c9b8d0f842ce3a28be14c3a5796` allowed the documented empty-repository 409 to reach Contents bootstrap.
   - Follow-up RED: `a1362712f9e3c4a0d34d0c44847f62f1733f0394` proves a generic/unavailable 409 must not be interpreted as an empty repository.
   - Final fix: `4959c07acd5ae6007ec66a925050edcd40bfb76f` returns `null` only for 404 or a 409 whose GitHub error explicitly reports that the Git repository is empty; other 409 conflicts propagate fail-closed.

70. **MEDIUM remote resource/fail-late safety — resolved operations could exceed journal capacity only after staging or streamed object uploads had already started.**
   - The journal writer contract is 500 changes/page × 256 pages = 128,000 changes per publication, but `buildV4JournalPages()` was the first place enforcing that limit.
   - For large/chunked or packed pushes, `V4SyncSession` can create immutable Git blobs while building push records before it later constructs journal pages. An operation with more than 128,000 resolved journal changes could therefore fail deterministically after creating orphan remote objects; pull/conflict staging could also be performed unnecessarily before the inevitable writer rejection.
   - RED: `5655f2b3f565bf3b1b8912524b798f76336c2659` requires the journal capacity to be preflightable from a change count without materializing an oversized change array.
   - Fix: `647fbeeaade34008162d4382955afc37a787bf09` centralizes the writer-compatible capacity assertion and checks the exact resolved journal entry count — external-reconciliation pulls plus final resolved pushes — immediately after conflict resolution and before packed-pull staging, final local mutation, or streamed Git blob upload.
   - This remains a per-publication journal bound, not a global vault file-count limit; large vaults remain supported as long as one atomic publication stays inside the existing protocol journal contract.

71. **MEDIUM/HIGH remote resource safety — direct plaintext external reconciliation re-downloaded every unchanged vault blob.**
   - When a plaintext branch contained a direct external Git edit after the locally known V4 publication, `reconcileExternalCommit()` traversed the full current tree and called `getFileBytes()` for every in-scope blob, even when an immutable baseline tree proved that most blob object IDs were unchanged.
   - A one-file manual GitHub edit in a large vault could therefore expand into thousands of Contents/blob reads, consuming rate-limit budget and making sync latency proportional to total vault size instead of the external delta.
   - RED: `909c7442c6b6da3aea6f1d8eda9db87a3d657d29` proves an unchanged plaintext file was fetched during a one-file external edit.
   - Fix: `48d103dc95b2c75feba43deabf40f56c2305804c` compares the current immutable tree with the locally known immutable baseline tree and reuses the authenticated V4 record when the path/blob object ID is unchanged.
   - Reuse is deliberately gated by `localIndexMatchesRemoteHead()`; if the local metadata manifest is stale relative to the authenticated remote head, reconciliation keeps the prior full-read behavior rather than reusing records from the wrong generation. Closing that stale-device amplification path safely requires a bounded proof of which ancestor owns the inherited V4 metadata.
   - The sync-session fixture now models tree child IDs as content-sensitive values so tests preserve the content-addressed Git invariant required by this optimization.

72. **HIGH bootstrap side-effect safety — generic any-ref HTTP 409 could still enter Contents bootstrap and mutate remote state before failing.**
   - Finding 69 hardened the configured-branch lookup, but the broader `inspectAnyGitRef()` preflight still treated every HTTP 409 as proof that the repository was empty.
   - A populated or temporarily unavailable repository returning a generic refs conflict could therefore enter the empty-repository Contents bootstrap loop and issue remote PUT mutations before later root/message/tree verification rejected the result.
   - RED: `0b097d3a4334096d90bea438d09d111bb28109f4` returns `409 Git Repository is temporarily unavailable.` from the any-ref preflight and proves the client attempted the bootstrap Contents PUT twice instead of failing before mutation.
   - Fix: `5d7f4d211d22b73a4383972430ccd6ab4a039c5e` centralizes explicit empty-repository conflict detection for both configured-ref and any-ref reads. Only 404 or an explicit empty marker (`empty` / GitHub's `Git Repository is empty.`) is treated as absent; other 409 conflicts propagate before any bootstrap mutation.
   - Focused bootstrap/ref transport regressions remain green, including legacy fixture shorthand `empty`, while `temporarily unavailable` remains fail-closed.

73. **HIGH bootstrap concurrency correctness — a definitive create-ref conflict at the already-verified bootstrap SHA was not reconciled.**
   - `ensureConfiguredBootstrapRef()` first reads the configured branch, then creates it if absent. Another actor can create that same ref in the race window after the initial 404 and before our POST.
   - The existing code reconciled ambiguous/unknown mutation outcomes but propagated definitive 409/422 create conflicts immediately, even when a read-back proved the configured ref already pointed exactly at the authenticated bootstrap commit.
   - Regression commit: `72529e40a16c1bbe32a02fdeafc936cd4f5050da` covers the definitive already-exists race at the verified SHA.
   - Fix: `5ed8abe` reconciles definitive 409/422 ref-create conflicts by reading the configured ref back and accepting it only through the existing exact-SHA `assertConfiguredBootstrapRef()` proof.
   - A second regression proves a competitor SHA remains a typed `V4RepositoryBootstrapRaceError`; the conflict path therefore becomes idempotent only when the observed ref is exactly the verified bootstrap commit and remains fail-closed otherwise.

74. **HIGH remote-state integrity — a maximum safe remote generation could overflow on the next publication and create an unreadable head.**
   - `decodeV4RemoteHead()` correctly accepts every non-negative safe-integer generation, including `Number.MAX_SAFE_INTEGER`.
   - The publication path then used `remote.head.generation + 1` without checking that the successor remained a safe integer. A valid max-generation remote plus any push/Force Push could therefore encode an unsafe generation into the new V4 head after remote object work had begun; the next reader would reject that head as invalid.
   - RED: `015df6301bbf264930166ef861075895630099d0` proves a max-generation remote could proceed instead of rejecting before blob/tree/commit/ref side effects.
   - Fix: `b10522ea4e2fd2f942afd3cbca1ea0ed971b4da3` fail-fast guards the publication branch before publication-base resolution or remote uploads and reuses the checked generation for the increment.
   - Pure pull/no-publication flows still return before this guard, so a vault can still recover/read a max-generation remote; only a new publication is blocked until the protocol generation is reset through an explicit migration/reinitialization path.

75. **MEDIUM/HIGH Force Push mirror safety — managed remote gitlinks/submodules could survive an exact-mirror Force Push.**
   - Force Push recursive-tree cleanup previously deleted only blob entries. An in-scope Git tree entry with `type: "commit"` / mode `160000` (gitlink/submodule) was skipped, so the operation could report a successful exact mirror while leaving managed remote state that does not exist in the local vault.
   - RED: `34bf179` proves an in-scope remote gitlink survived Force Push, while an explicitly out-of-scope gitlink remains a legitimate preserved entry.
   - Fix: `620c3bb` treats a managed gitlink as unsafe and fails before candidate publication; out-of-scope gitlinks remain untouched by scope policy.

76. **MEDIUM lifecycle/settings safety — a settings save could resume after plugin unload and recreate scheduled runtime work.**
   - `saveSettings()` quiesces the runtime, stores secrets, then awaits durable settings persistence. If the plugin is disabled/unloaded while that await is pending, `onunload()` disposes the runtime and clears timers, but the resumed save previously still published in-memory settings, recreated the GitHub client, and called `registerScheduledSync()`.
   - Because `registerScheduledSync()` itself had no unload guard, this could install a new interval after unload and retain callbacks against a disposed plugin/runtime generation.
   - RED: `014e073` requires late settings persistence to stop before runtime/client/timer publication and requires scheduled registration itself to be inert after unload.
   - Fix: `d8c3c6b` returns immediately after successful durable persistence when `this.unloaded` is true, and `registerScheduledSync()` now fails closed after unload. The `finally` path still releases the settings-transition gate.
   - Focused settings/runtime coverage is green at **52/52**.

77. **HIGH external plaintext reconciliation safety — an in-scope gitlink/submodule could be interpreted as a remote deletion and trash the local file.**
   - Direct external plaintext reconciliation rebuilt logical remote state from recursive-tree blob entries and silently skipped every non-blob. If an external commit replaced a managed file path with a Git gitlink/submodule (`type: "commit"`, mode `160000`), that path disappeared from reconciled metadata even though the remote tree still contained an object at the path.
   - The planner could then treat an unchanged local file as remotely deleted, apply the pull through trash/delete semantics, and later publish V4 metadata that still did not represent the surviving gitlink.
   - RED: `4dce43d` replaces `note.md` with an in-scope gitlink in an external commit and proves normal sync proceeded instead of rejecting before local mutation.
   - Fix: `fe8b8e7` validates gitlink paths during external reconciliation and fails closed for internal or in-scope gitlinks/submodules before planning/local mutation; explicitly out-of-scope gitlinks remain untouched.
   - Focused `sync-session` coverage is green at **100/100** after the fix.

78. **HIGH external plaintext reconciliation safety — a managed Git symlink could be consumed as ordinary file bytes and replace local content.**
   - Recursive Git trees report a symlink as `type: "blob"`, mode `120000`. External reconciliation previously special-cased gitlinks but otherwise treated every blob mode as a normal file.
   - The session could therefore read the symlink blob payload, hash it as file content, plan a pull, and replace a managed local file with the symlink target text instead of rejecting an unsupported filesystem object.
   - RED: `b7518a4` replaces `note.md` with an in-scope mode-`120000` symlink and proves normal sync did not reject before the local mutation path.
   - Fix: `ed76ca7` accepts only regular managed blob modes `100644` / `100755`; internal or in-scope symlinks and other unsupported blob modes fail closed before body reads/planning/local mutation, while out-of-scope objects remain untouched.
   - Focused `sync-session` coverage is green at **101/101** after the fix.

79. **MEDIUM crash-recovery integrity — the local recovery generation could overflow past the safe-integer contract and persist an unreadable successor.**
   - Recovery headers correctly accept non-negative safe-integer generations, including `Number.MAX_SAFE_INTEGER`, but `save()` previously computed `generation + 1` without a successor check.
   - An integrity-valid max-generation recovery state could therefore cause the next save to write an unsafe generation that later readers reject, undermining crash-recovery continuity after the write.
   - RED: `38f6266` installs a valid max-generation slot and proves the next save proceeded instead of rejecting before any write.
   - Fix: `2d00466` checks the current generation before encryption/directory/write side effects and raises `V4RecoveryRequiredError` when no safe successor exists.
   - Recovery coverage is green at **49/49** after the fix.

80. **MEDIUM/HIGH plugin lifecycle safety — async startup could finish after unload and recreate disposed plugin work.**
   - `onload()` awaited settings loading and, when secret migration was needed, durable settings persistence before constructing the runtime, views, timers, commands, ribbon actions, and vault event handlers.
   - If the plugin was disabled/unloaded while either startup await was pending, `onunload()` set the disposed state and cleared existing work, but the resumed `onload()` previously had no lifecycle guard and could continue creating new runtime/UI/timer/event state after unload.
   - RED: `dd7e97d` requires startup to stop after both async settings boundaries when `this.unloaded` has become true.
   - Fix: `df2bc0a` checks the unload sentinel immediately after `loadSettings()` and again after optional migrated-settings persistence, before any runtime/client/view/timer/event registration occurs.
   - Focused settings/runtime coverage is green at **53/53** after the fix.

81. **MEDIUM/HIGH secret-migration durability — unload during settings load could skip durable cleanup of migrated legacy secrets.**
   - Legacy settings migration moves raw token/passphrase values into Obsidian SecretStorage and marks the in-memory settings as migrated so the old cleartext fields can be removed from plugin data.
   - Finding 80 added an unload guard immediately after `loadSettings()`. If unload happened while `loadSettings()` was awaiting and migration completed before that await returned, the guard could return before `persistData()`, leaving the legacy raw secret fields durably present in plugin data even though the plugin instance had already migrated them into SecretStorage.
   - RED: `ff149f941c7dbb1b0111baaa7d126af0bfad3226` requires migrated-secret cleanup persistence to occur before unload can short-circuit startup runtime creation.
   - Fix: `78ba901` preserves the lifecycle safety from finding 80 but orders startup as load → optional migrated-settings persistence → unload guard → runtime/UI creation. Unload during settings loading therefore cannot recreate runtime work, while migrated raw secrets are still durably scrubbed before startup returns.
   - Focused settings/runtime coverage is green at **54/54** after the fix.

82. **HIGH settings/credential integrity — malformed persisted settings could mutate SecretStorage before being rejected.**
   - `loadSettings()` merged persisted data with defaults, then called `migrateV4Secrets()` before `assertPluginSettingsRuntimeSafe()`.
   - `migrateV4Secrets()` can write legacy raw token/passphrase values into SecretStorage. Therefore structurally unsafe persisted settings could overwrite or create durable secret entries before startup validation rejected the settings object.
   - RED: `0d7bf41` requires persisted settings validation to occur before any secret-migration side effect.
   - Fix: `2279fa9` validates the merged persisted settings before calling `migrateV4Secrets()`, while retaining the existing post-migration validation of resolved runtime settings.
   - Focused settings/runtime coverage is green at **55/55** after the fix.

83. **MEDIUM/HIGH Force Push mirror safety — a managed explicit empty Git tree could survive an exact-mirror Force Push.**
   - Force Push cleanup rejected managed gitlinks and deleted managed blobs, but skipped every `type: "tree"` entry in the recursive Git tree.
   - Git can contain an explicit empty tree object with no descendant entries. Because Obsidian vault sync has no content object corresponding to that empty directory, such a managed tree could survive Force Push while the operation reported an exact managed mirror.
   - RED: `9bc0fa2` injects an in-scope `type: "tree"`, mode `040000` entry with no descendants and proves Force Push completed instead of rejecting the unmirrorable remote state.
   - Fix: `37f5f55` precomputes directory paths that are proven non-empty from recursive-tree descendants and fails closed only for managed tree entries with no descendants. Ordinary non-empty directories and out-of-scope tree entries keep their prior behavior.
   - Focused `sync-session` coverage is green at **102/102** after the fix.

84. **HIGH external reconciliation safety — a tracked file replaced by a Git directory could be misclassified as a remote deletion.**
   - Plaintext external reconciliation previously skipped recursive-tree directory entries and later inferred absence for the tracked file path from the lack of a blob entry.
   - If an external Git commit replaced a tracked file such as `note.md` with a directory at the same path, normal sync could therefore plan local deletion instead of recognizing an unsupported file→directory topology change.
   - RED: `2d8d32a` replaces a tracked file with a Git tree and proves the sync path could otherwise reach local deletion semantics.
   - Fix: `1613d05` fails closed when an in-scope recursive-tree directory occupies a path that is already represented by an authenticated tracked file record, before any local mutation or metadata publication.

85. **HIGH recovery/local topology safety — a directory→file pull could write before removing blocking descendants or fail on a surviving empty folder.**
   - Recovery payloads were emitted in planner order. When remote state replaced a local directory subtree such as `dir/file.md` with a file at `dir`, the stage-write for `dir` could precede the descendant trash and fail because the filesystem topology still blocked the target.
   - On the real Obsidian vault adapter, deleting the last descendant can still leave an empty `TFolder` object at the target path; desktop staged commit and direct vault writes then observe a directory where the file precondition expects no file.
   - RED: `3526f19` proves recovery must remove blocking descendants before writing the parent file.
   - Fix: `ffb71e0` topologically orders blocking trash mutations before stage-writes, derives pull completion from each pull group's actual terminal mutation, removes only empty target folders before file creation/commit, and refuses to replace non-empty folders.
   - Focused recovery boundary coverage is green at **3/3** and vault-write adapter coverage at **2/2** after the fix.

86. **MEDIUM/HIGH recovery liveness — vault topology races could hard-fail instead of triggering a safe replan.**
   - The vault adapter correctly refused to replace a non-empty folder with a file and refused to create a parent directory where a file already existed, but those failures were generic errors.
   - Recovery treats `V4LocalTargetChangedError` or an equivalent `local target changed` signal as evidence to persist `replan-required`. Generic topology errors therefore could leave recovery in `local-committing` and repeat the same failure after a concurrent user/out-of-scope topology change.
   - RED: `6bbd6f5` requires both non-empty-folder targets and file-as-parent conflicts to be classified as local target changes.
   - Fix: `be6fcf8` marks both vault topology safety errors as `V4 local target changed`, allowing the existing recovery replan path to preserve local state instead of hard-failing.
   - Focused vault-write coverage is green at **3/3** and recovery-boundary coverage remains **3/3** after the fix.

87. **MEDIUM/HIGH recovery resource safety — topology ordering introduced an O(N²) trash/write scan for large pull payloads.**
   - The directory→file recovery fix initially classified each trash mutation by scanning every staged-write path with ancestor/descendant checks.
   - Large Force Pull or recovery payloads can contain many thousands of writes and trashes, so the pairwise scan scaled quadratically even though the surrounding sync/recovery pipeline is designed for large vaults.
   - RED: `39bc40f` exercises 10,000 staged writes plus 10,000 unrelated trash mutations and measured about **2.28s CPU** before failing a 0.75s resource ceiling.
   - Fix: `235fb98` replaces pairwise scanning with an exact-path set, ancestor lookup, sorted write paths, and binary prefix search. The same 20,000-mutation regression now completes in tens of milliseconds while preserving the recovery topology ordering regression.
   - Focused resource regression is green at **1/1**; recovery-boundary semantics remain **3/3**.

88. **HIGH remote-state integrity — authenticated V4 records could describe filesystem-impossible file-prefix collisions.**
   - Complete remote-record validation rejected exact duplicate logical paths but did not reject one logical file path being an ancestor of another, such as `dir` and `dir/file.md`.
   - The local writer cannot produce that state from an Obsidian vault, but a forged/corrupt authenticated remote metadata set could pass record hashes/pathId checks and reach planning/recovery even though no filesystem can materialize both files simultaneously.
   - RED: `af9c879` constructs valid plaintext records for `dir` and `dir/file.md` and proves `assertV4RemoteRecordSet()` accepted them.
   - Fix: `5b78259` validates the complete logical-path set for file ancestors by walking slash-delimited prefixes against the already authenticated path set. The check is order-independent and O(total path depth), with no additional remote reads.
   - Focused remote-index coverage is green at **18/18** after the fix.

89. **HIGH cross-platform remote-state integrity — authenticated records could collide only after NFC/case-insensitive canonicalization.**
   - The local writer already rejects logical path sets such as `Notes/A.md` plus `notes/a.md`, and NFC-equivalent names such as composed/decomposed `Café.md`, because those names cannot be represented distinctly on all supported vault filesystems.
   - Complete remote-record validation previously rejected only exact duplicates and file-prefix topology collisions. A forged/corrupt authenticated metadata set could therefore pass with canonical-name collisions that are impossible to materialize safely on case-insensitive or Unicode-normalizing platforms.
   - RED: `d585a37` proves `assertV4RemoteRecordSet()` accepted both case-insensitive and NFC-equivalent collisions.
   - Fix: `ce673e9` applies the same `NFC + lowercase` canonical key used by the local writer to the authenticated remote record set and rejects any distinct logical paths sharing that key.
   - Focused remote-index coverage is green at **19/19** after the fix.

90. **HIGH cross-platform remote topology integrity — a file ancestor collision could exist only after NFC/case-insensitive canonicalization.**
   - Finding 89 rejected distinct logical paths that canonicalize to the same full path, but the file-prefix topology check still walked the original case-sensitive logical path set.
   - A forged/corrupt authenticated record set such as file `Dir` plus file `dir/child.md` (or NFC-equivalent ancestor spellings) could therefore pass despite being impossible to materialize on supported case-insensitive/normalizing filesystems.
   - RED: `e64a7e7` proves both case-insensitive and NFC-equivalent file-ancestor collisions passed `assertV4RemoteRecordSet()`.
   - Fix: `9bf77af` walks the already-authenticated canonical path map for slash-delimited ancestors in addition to the exact logical-path topology check, preserving O(total path depth) validation with no remote reads.
   - Focused remote-index coverage is green at **20/20** after the fix.

91. **HIGH external reconciliation integrity — direct Git edits could synthesize a V4 record set that violated the complete portable path topology contract.**
   - Authenticated V4 metadata now rejects exact, canonical, and file-prefix path collisions, but plaintext external Git reconciliation rebuilt `remote.records` directly from the recursive Git tree without re-running that complete record-set contract.
   - Git can represent path sets such as file `Dir` plus file `dir/child.md` that are legal in the repository but impossible to materialize safely on all supported vault filesystems. The old reconciliation path could read those blob bodies, mutate a case-sensitive vault, and publish replacement V4 metadata that the next strict V4 load would reject.
   - RED: `045a0aa` covers both new-new external canonical topology and tracked-file-plus-new-descendant variants. It proves the unsafe tree reached blob body reads and could reach local mutation/publication instead of failing at the structural boundary.
   - Fix: `b2f75c7` extracts the canonical/exact path-set topology validator, preflights managed external Git file paths before blob reads, and validates the fully reconciled plaintext record set again before installing it into remote state.
   - Focused coverage is green at **105/105** for sync-session and **20/20** for remote-index after the fix.

92. **MEDIUM/HIGH Git tree evidence integrity — successful tree responses could pair an object type with an incompatible Git mode.**
   - `getTreeAt()` validated entry path, object SHA, type, blob size, and duplicate paths, but did not bind the Git mode to the declared object type.
   - A malformed successful GitHub response could therefore describe combinations such as `type: "blob", mode: "040000"`, `type: "tree", mode: "100644"`, or `type: "commit", mode: "100644"`. Different downstream consumers inspect different subsets of those fields, so the same remote evidence could be interpreted inconsistently.
   - RED: `5ec2801` proves all three incompatible mode/type pairs were accepted at the tree decode boundary.
   - Fix: `27eb8eb` accepts only canonical Git mode/type pairs: blob `100644|100755|120000`, tree `040000`, and gitlink/commit `160000`; legitimate symlink/gitlink objects remain available for the later scope-specific policy checks.
   - Focused Git tree mode validation is green at **1/1** and github-transport remains **43/43** after the fix.

93. **MEDIUM/HIGH external reconciliation integrity — managed explicit empty Git trees could be silently carried into a plugin publication.**
   - Force Push already rejects an in-scope explicit empty Git tree because Obsidian vault state has no file object that can represent it, but plaintext external reconciliation only validated file blobs, gitlinks, symlinks, and tracked-file→directory replacements.
   - An external commit containing an in-scope empty tree could therefore be accepted, followed by a replacement V4 metadata publication that preserved the empty tree in the repository while making the commit look like a normal plugin publication.
   - RED: `e4f66ff` injects an in-scope recursive-tree entry with no descendants and proves normal external reconciliation published instead of failing closed.
   - Fix: `77ed62b` computes the bounded set of tree paths proven non-empty from recursive-tree descendants and rejects managed tree entries with no descendants before blob reads, local mutation, or metadata publication. Internal V4 trees, out-of-scope trees, and ordinary non-empty directories keep their prior behavior.
   - Focused sync-session coverage is green at **106/106** after the fix.

94. **HIGH external publication evidence integrity — external Git commits could tamper the internal V4 subtree while preserving the advertised head and then be laundered into a plugin publication.**
   - Plaintext external reconciliation authenticated the current V4 head, but cached shard reuse could avoid re-reading unchanged advertised shard hashes and the reconciliation path did not prove that the commit's `.obsidian-github-sync-v4` subtree matched the last verified plugin publication.
   - A direct Git commit could therefore alter an internal shard while leaving `head` unchanged, then reach external reconciliation and replacement metadata publication even though the internal V4 tree itself was no longer the authenticated plugin state.
   - RED: `d7ee3db` tampers an internal V4 shard while preserving the head and proves the commit reached reconciliation instead of failing closed. Review also exposed a generation-1 marker bypass; `6d85a80` proves a forged generation-1 plugin marker whose parent temporarily lost the V4 head must not be trusted merely because the head is generation 1.
   - Fix: `c32c886` binds plugin-publication classification to the exact immutable head at each candidate commit, walks at most 256 ancestors to a verified publication, trusts the generation-1 missing-parent-head case only when its SHA is the locally verified `index.remoteCommitSha`, and compares the non-recursive V4 root tree object SHA between that verified baseline and the external tip before any reconciliation.
   - Test-fixture follow-up `01f04fb` makes retry/runtime Git doubles model non-recursive root-tree reads without weakening production validation.
   - Focused sync-session coverage is green at **108/108**; publication-race **1/1**, runtime-retry **1/1**, and settings-secrets **55/55** also pass with the stricter evidence path.

95. **HIGH plugin-publication classification integrity — valid marker/head progression could still hide managed user-tree edits.**
   - After finding 94, plugin markers and head progression were authenticated, but a forged commit could increment generation/journal correctly while changing managed plaintext blobs outside the internal V4 subtree.
   - RED: `f894dcf` proves a commit with a valid-looking plugin message and head progression could hide a managed blob edit and be treated as a plugin publication instead of external Git state.
   - Fix: `8e91084` compares parent/tip Git trees through bounded non-recursive tree evidence, rejects encrypted publications with user-tree changes, and for plaintext accepts only changes that correspond exactly to authenticated current/previous records.
   - Regression follow-up `d9b0fd8` preserves legitimate encrypted publication classification under the stricter tree-change rules.

96. **HIGH publication body integrity — forged metadata could claim one plaintext body while the publication tree pointed at different blob bytes.**
   - A malicious publication could update authenticated record metadata to a hash/size that matched the current local file while its Git tree referenced a different blob. Local-match shortcuts could otherwise avoid fetching the remote body and let the forged publication advance trust.
   - RED: `3fc0246` proves the changed Git blob could disagree with the authenticated current record while local bytes matched the forged metadata.
   - Fix: `8e91084` reuses the verified changed-leaf evidence and, whenever local bytes already match the authenticated record, computes the Git blob object ID of those bytes and requires it to equal the changed tree leaf SHA before the publication can be trusted.

97. **MEDIUM/HIGH publication evidence resource safety — exact tree-change verification could amplify into unbounded non-recursive tree reads.**
   - The semantic tree verifier initially recursed through every changed directory without an aggregate transport/node budget. A hostile or unusually wide/deep tree could therefore force thousands of Git tree reads before classification failed.
   - RED: `72b2a79` models 3,000 changed root directories and proves publication verification needs a hard aggregate read bound.
   - Fix: `1c9b6f5` caps publication-tree verification at **4,096 tree reads** and **250,000 decoded tree nodes**, failing closed on budget exhaustion or truncated evidence.
   - Fixture follow-ups `e12bc41` and `b7635b7` make conflict/recovery Git doubles model non-recursive tree reads without weakening production validation.
   - Focused publication-tree resource coverage is green at **1/1**.

98. **HIGH cached-shard publication integrity — a forged plugin publication could tamper a shard that the loader reused from the local cache.**
   - Remote loading can legitimately reuse a locally cached shard when its cached canonical hash matches the advertised head hash. A forged commit could keep that advertised hash unchanged, alter the actual shard blob in the publication tree, and increment the plugin head; the cached path would then avoid reading the tampered shard body.
   - RED: `10b4aae` tampers an internal index shard while keeping the new head's shard hash unchanged and proves the forged publication could otherwise advance the trusted baseline.
   - Fix: `5104c91` identifies buckets satisfied from the local cache and proves their immutable shard blob SHAs are unchanged between the trusted baseline commit and the candidate publication using the same bounded non-recursive tree evidence budget.
   - Focused sync-session coverage is green at **112/112** after the fix; publication-tree resource coverage remains **1/1**.

99. **MEDIUM/HIGH publication evidence resource safety — each ancestry candidate could reset the semantic tree-verification budget.**
   - Finding 97 bounded one publication-tree comparison, but ancestry search can inspect multiple candidate plugin commits before finding a trusted baseline.
   - The earlier implementation created fresh tree-read/node budgets inside candidate-specific cached-shard and tree-consistency checks, so several individually bounded candidates could exceed the intended aggregate verification ceiling during one ancestry search.
   - RED: `9e1c89a` chains multiple deep candidate publications and proves ancestry verification needs one shared aggregate tree budget rather than one budget per candidate/sub-check.
   - Fix: `645ba05` creates the publication-tree budget once in `findVerifiedPluginPublication()` and threads the same object through cached-shard proof and semantic tree verification for every ancestry candidate.
   - Focused publication-tree resource coverage is green at **3/3** after the subsequent queue-cost regression below.

100. **MEDIUM publication ancestry resource safety — repeated parent SHAs could amplify CPU through flat-array queue shifting.**
   - Ancestry traversal already limited unique verified commits to 256, but it copied `tip.parentShas` into a flat queue and consumed it with `Array.shift()`.
   - A malformed/hostile commit with a very large repeated parent list could therefore perform substantial queue maintenance even though `visited` caused only one commit read. The RED case with 100,000 duplicate parent SHAs used about **578ms CPU** on the qualification runtime.
   - RED: `0dd07bd` requires the duplicate-parent ancestry case to stay within a bounded CPU budget while still reading the duplicated commit only once.
   - Fix: `e7beb37` preserves breadth-first ordering and the 256-commit verification limit by traversing parent lists with cursors/iteration instead of copying and shifting one flat queue; duplicate SHAs are skipped through the existing `visited` set. The same regression now runs in about **2.5ms CPU**.
   - Focused publication-tree resource coverage is green at **3/3**.

101. **MEDIUM/HIGH credential persistence safety — a failed settings save could leave newly generated orphan credentials in SecretStorage.**
   - Credential changes intentionally receive fresh secret IDs so a failed plugin-data persistence does not overwrite the still-persisted credential value. However, the new token/passphrase values were written to SecretStorage before `persistSettingsData()` and were not scrubbed if that durable settings write failed.
   - The runtime generation stayed unchanged after persistence failure, but the failed save could still leave an unreachable durable credential copy whose ID was never committed to plugin data.
   - RED: `22c359e` requires failed settings persistence to scrub only the newly generated pending token/passphrase secret IDs and still rethrow the save failure without touching the previously persisted secret IDs.
   - Fix: `e838aad` tracks which secret IDs are new for the pending settings transaction, wraps secret staging plus settings persistence in one failure boundary, clears only those pending IDs on failure, and leaves the previously persisted credentials untouched.
   - Focused settings-secrets coverage is green at **56/56** after the fix.

102. **MEDIUM/HIGH startup credential migration safety — failed migration persistence could create a new orphan SecretStorage copy on every startup retry.**
   - Legacy settings migration can generate fresh secret IDs and write the raw legacy token/passphrase into SecretStorage before `onload()` persists the sanitized settings that reference those IDs.
   - If that migrated-settings persistence failed, startup aborted but the newly created IDs were never committed to plugin data. Retrying startup could generate another pair of IDs and leave another unreachable durable credential copy each time.
   - RED: `d6588d9` requires startup migration failure to scrub only secret IDs that were newly generated for persisted legacy values while preserving any pre-existing secret IDs.
   - Fix: `d00d8d4` tracks migration-created secret IDs, wraps migrated-settings persistence in a rollback boundary, clears only those pending IDs on failure, and clears the pending list after persistence succeeds; runtime/UI creation still remains behind the unload guard.
   - Focused settings-secrets coverage is green at **57/57** after the fix.

103. **HIGH credential migration atomicity — a partial SecretStorage failure could leave overwritten or orphaned credential values even though migration threw.**
   - `migrateV4Secrets()` can write both the legacy GitHub token and encryption passphrase. If one SecretStorage write succeeded or mutated storage and a later write failed, the function propagated the error without restoring the earlier value(s).
   - Existing secret IDs could therefore remain overwritten with uncommitted migrated values, while newly generated IDs could retain orphan credential copies despite the migration being reported as failed.
   - RED: `7cd92e7` simulates a later SecretStorage write failure and proves both pre-existing and newly generated IDs must return to their exact pre-migration state.
   - Fix: `a8fe164` snapshots every unique secret ID that migration may write, performs the writes inside one synchronous transaction boundary, and on failure restores prior values (or scrubs newly created IDs to empty) across all attempted IDs while preserving the original migration error.
   - Focused settings-secrets coverage is green at **58/58** after the fix.

104. **HIGH credential identity integrity — token and passphrase could alias the same SecretStorage ID and silently overwrite each other.**
   - Persisted/runtime settings previously allowed `githubTokenSecretId === encryptionPassphraseSecretId`.
   - Settings save and migration write the token and passphrase independently, so a shared ID could make the second credential overwrite the first. Runtime memory could still hold distinct values temporarily, but a later restart would load both credentials from the same stored value and corrupt one of them.
   - RED: `f2d2203` proves both runtime-settings validation and direct secret migration accepted an aliased non-empty secret ID and could reach SecretStorage mutation.
   - Fix: `9c00d2c` centralizes a distinct-secret-ID invariant and enforces it in runtime settings validation, `migrateV4Secrets()`, and `storeV4Secrets()` before any secret read/write sequence can alias credentials.
   - Focused settings-secrets coverage is green at **59/59** after the fix.

105. **MEDIUM/HIGH credential cleanup durability — one SecretStorage scrub failure could stop cleanup before later pending credentials were attempted.**
   - Findings 101–103 added rollback/scrub paths for newly generated pending token/passphrase IDs, but those cleanup loops wrote each SecretStorage entry directly and would stop at the first thrown cleanup error.
   - A persistence/migration failure followed by a SecretStorage failure on the first pending ID could therefore leave later pending credential IDs unscrubbed even though the caller reported cleanup failure.
   - RED: `4d54485` requires credential cleanup to attempt every unique pending secret ID even when an earlier scrub throws, then report the cleanup failure only after the full set has been attempted.
   - Fix: `7ac4fc6` centralizes rollback cleanup in `scrubV4SecretIds()`, deduplicates IDs, continues across individual SecretStorage failures, preserves the first cleanup error as the cause, and uses the helper in both startup-migration and settings-save rollback paths.
   - Focused settings-secrets coverage is green at **60/60** after the fix.

106. **MEDIUM/HIGH credential retention — successful credential rotation left superseded SecretStorage values orphaned indefinitely.**
   - Settings save intentionally rotates token/passphrase changes onto fresh secret IDs before durable plugin-data persistence, so a failed save cannot overwrite the still-committed credential reference.
   - After a successful save, however, the old secret IDs were never scrubbed. Repeated token/passphrase changes could therefore accumulate unreachable durable copies of prior credentials in SecretStorage even though plugin data referenced only the newest IDs.
   - RED: `4a3f112` requires superseded credential IDs to be selected centrally, excludes any old ID reused by the new settings generation, and proves cleanup must occur only after `persistSettingsData()` has durably committed the new references.
   - Fix: `49b7ac2` adds `supersededV4SecretIds()`, scrubs only no-longer-active IDs after durable settings commit, keeps that post-commit cleanup best-effort/non-transactional so cleanup failure cannot roll back or desynchronize the committed settings generation, and still reports a non-sensitive warning while the plugin remains loaded.
   - Focused settings-secrets coverage is green at **61/61** after the fix.

107. **MEDIUM credential persistence robustness — unrelated settings saves rewrote unchanged SecretStorage values.**
   - `saveSettings()` already knew whether the token or passphrase had changed because credential changes rotate onto fresh secret IDs, but it still called `storeV4Secrets()` in an all-credentials mode on every settings save.
   - Saving an unrelated option therefore rewrote both durable credentials unnecessarily, increasing SecretStorage write/failure surface and allowing a secure-storage write failure to block settings that did not change credentials.
   - RED: `5361768` proves unchanged token/passphrase values still triggered SecretStorage writes and requires the settings-save call site to pass explicit per-credential write selection.
   - Fix: `fa6a36a` adds optional selective writes to `storeV4Secrets()` and passes the existing pending-token/pending-passphrase flags from `saveSettings()`, while retaining the default all-credentials behavior for direct compatibility callers.
   - Focused settings-secrets coverage is green at **62/62** after the fix.

108. **HIGH encrypted publication object integrity — plugin publication classification could trust changed encrypted content objects whose authenticated metadata descriptors were unchanged.**
   - Encrypted user content lives under the internal V4 `data/`, `parts/`, and `packs/` namespaces. Publication tree classification intentionally excludes the top-level internal V4 subtree from plaintext user-tree change detection.
   - A forged commit could therefore preserve valid encrypted head progression and unchanged authenticated shard metadata while replacing an encrypted content object. Before this fix, that object-only mutation could be classified as the next plugin publication and advance the trusted baseline without proving that metadata authorized the content-object change.
   - RED: `4b76f6c` changes only an encrypted content object while keeping the current record/shard metadata unchanged. The regression was strengthened so the local vault deliberately diverges and uses the metadata-only `newer` policy, proving rejection does not depend on a later local-match/body-read shortcut.
   - Fix: `135b961` traverses changed encrypted `data/parts/packs` leaves under the existing shared publication-tree budget, requires every changed current object to be referenced by authenticated current metadata, and compares the exact object-relevant record descriptor against the authenticated parent shard. Parent shards are loaded only for buckets whose head hash changed, are themselves bound to the parent head's canonical shard hash, and are cached per bucket. An encrypted object cannot change when its record descriptor is unchanged even if another record in the same shard changed.
   - Shared pack objects receive an additional bounded proof: a changed pack must bind to the immutable tree leaf SHA and decrypt/validate all current pack entries before the publication is trusted. Single/chunked objects avoid eager body downloads and remain AEAD/hash-checked when read normally.
   - Focused sync-session coverage is green at **113/113** after the fix.

109. **HIGH encrypted publication journal integrity — a forged current journal object could pass plugin-publication classification without authenticating its page bytes.**
   - RED: `ce92998` changes the encrypted journal blob of an otherwise legitimate generation-two publication and proves that the stale device must not advance its trusted remote baseline or mutate its local vault.
   - Fix: `ccc3ebc` verifies the current journal directory against the head journal ID, requires canonical page blob names and counts, binds each immutable journal blob SHA to the commit tree leaf, authenticates AES-GCM ciphertext with the repository/journal/page AAD, and rejects invalid or inconsistent page headers before declaring the tip a plugin publication.
   - This is **publication-classification evidence**, not proof of semantic equivalence between every journal change descriptor and the full remote record set; keep residual publication integrity review separate.

110. **MEDIUM Settings Save robustness/UX — overlapping submissions were not rejected at the plugin entry point and pending Save controls could be recreated enabled.**
   - RED: `tests/v4/settings-save-overlap.test.ts` invokes `FastSync.saveSettings()` twice with delayed persistence and a deliberately permissive runtime mock, observing two entries into settings transition; a Settings Tab test proved the banner rerender enabled another Save while the first awaited.
   - Actual `V4PluginRuntime.quiesceForSettingsChange()` already rejects a concurrent transition in production, so the demonstrated end-user bug is confusing double-submit/error feedback and absent plugin-level defense, **not confirmed cross-target corruption**.
   - Fix: plugin-level in-progress guard, unconditional release on both quiescence and persistence failure, UI-level pending flag surviving banner rerender, and disabled Save/Discard while saving.
   - GREEN: four focused scenarios including post-error and post-quiescence retry.

111. **MEDIUM historical preview memory/resource — external Git blob previews could bypass the 5 MiB preflight through unknown or stale descriptor sizes.**
   - RED: `tests/v4/history-service.test.ts` proves external version descriptor `size: 0` together with a tree blob missing its size or advertising 6 MiB previously entered the GitHub blob-download path.
   - Fix: `V4HistoryService.previewChange()` requires a safe numeric size on the selected external Git tree blob and fails before `getBlob()` for unknown or over-limit sizes, while preserving regular external previews.
   - Limitation: GitHub/Obsidian request-response buffering still occurs before any post-response check; this is a metadata preflight, not a streaming transport memory guarantee.

112. **LOW Sync Center error resilience — unexpected provider rejection shapes broke the error display.**
   - RED: Sync Center tests exercise `null` and string rejection from the async history provider. Prior `(error as Error).message` could throw on null or display undefined.
   - Fix: nonempty Error/string messages or a generic fallback, with one visible Notice and stable error panel.

113. **MEDIUM performance — progress rendering repeatedly re-coalesced the entire pending debounce queue on each vault event (quadratic burst cost).**
   - RED: new `tests/v4/settings-secrets.test.ts` regression submits 300 distinct modifications, instruments the `V4SyncCoordinator.pendingCount` read budget and confirms repeated full queue coalescing would exceed 128 reads.
   - Fix: O(1) `V4SyncCoordinator.pendingRawCount`; UI progress computes the expensive exact coalesced count only when raw queue length is at most 128, and thereafter shows an unknown total until the pending events are drained. Final coalesced sync requests and event causality stay unchanged.
   - GREEN: focused settings-secrets **63/63** including 300-event, 128-read, 300-queued-record assertion. Real device CPU/RAM burst measurements remain pending.

114. **MEDIUM Settings Clipboard lifecycle — stale paste completion could overwrite a reopened tab or newer import, and malformed clipboard JSON could inject non-string GitHub configuration values.**
   - RED `tests/v4/settings-clipboard-lifecycle.test.ts`: previous request overwrites reopened settings; older request wins out-of-order; numeric owner/object token/array branch are accepted into typed draft.
   - Fix: per-request paste generation, hide invalidation, draft identity and editable-field snapshot guards, nonempty string type validation before atomic application, live-region feedback and lifecycle-managed timer.
   - GREEN: focused Clipboard suite **4/4**, including user editing repo coordinates while clipboard permissions/read are pending. This is settings UI hardening; persistence still performs full coordinate/branch validation.

115. **LOW Settings Save lifecycle and dirty-target warning — late completed Save could rerender a hidden tab.**
   - RED `tests/v4/settings-save-overlap.test.ts`: close settings during delayed save; old completion calls `display()` despite `hide()`.
   - Fix: view epoch prevents stale Save-driven rerender after hide, preserves correct Save state on later revisit; dirty banner explicitly says Sync/Force actions still target the last saved repository/branch/scope.
   - GREEN: focused Settings Save **6/6** including overlapping clicks, quiescence/disk failures, hidden-tab rerender, and explanatory target warning.
   - Maintainer UX decision remains open: whether to disable Sync/Force entirely while settings are dirty; this patch warns without altering existing action semantics.

116. **MEDIUM UI stylesheet drift and cross-vault styling risk.** `pnpm build` does not compile SCSS, so distributed `styles.css` omitted the Settings headings/dirty banner despite source SCSS rules; source SCSS also had global Markdown image selectors that could affect user notes if recompiled. RED/GREEN `tests/v4/ui-styles-contract.test.ts`; removed unscoped selectors, brought both source and distributed styles in line for Settings, responsive and reduced-motion behavior, and force confirmation. A later follow-up closes the CSS build integration gap with pinned Sass and exact generated-CSS equality testing; see finding 121.
117. **MEDIUM Sync Center history selection / empty result.** Changing commit-history pages could show detail from a commit on a different page, and a commit without changes displayed only an unhelpful empty layout. RED/GREEN `tests/v4/sync-center-progress.test.ts` checks page-specific clearing and a clear no-changes message.
118. **LOW Status Bar keyboard accessibility.** Pointer-clickable sync status had no button semantics, focus target or Enter/Space handler. RED/GREEN `tests/v4/main-progress.test.ts` covers keyboard + existing busy/unload constraints.
119. **LOW Copy Debug notice/failure handling.** Clipboard write errors were unhandled; success text was ambiguous. RED/GREEN `tests/v4/settings-debug-copy.test.ts` exercises secure-redacted payload, awaited success, permission denial without false-success.
120. **LOW responsive Sync Center and active tab semantics.** Current-file/Commits mode buttons lacked active-state exposure and UI header/long path may overflow narrow views. RED/GREEN mode and CSS tests; `aria-pressed`, wrapped actions/path in both SCSS and published CSS.
- Comprehensive source-level **every UI surface** matrix in `docs/engineering/full-ui-surface-audit-2026-10-10.md`. **Important:** no real Obsidian visual/device acceptance is claimed; the connected Obsidian window belongs to an unrelated vault and was deliberately not manipulated. P1 unresolved: keyboard-accessible, equally deliberate Force-confirmation design.

121. **MEDIUM build-to-UI parity — shipped CSS was not byte-for-byte reproducible from SCSS.** The existing selector-presence contract passed even while the pinned Sass compiler's complete output differed from `styles.css`, including typography/spacing. `devcss` called a binary absent from dependencies, and `pnpm build` did not regenerate CSS. RED test `tests/v4/ui-styles-contract.test.ts` compared entire compiled CSS with published CSS and failed. Fix: pin `sass@1.93.2` in package/lockfile, add `build:css`, run it as part of normal `build`, simplify `devcss` to watch only, regenerate tracked `styles.css`, and assert exact compiled output in tests. GREEN focused suite **5/5**. Always qualify production CSS from a clean source checkout.
- **Real Obsidian Desktop test attempt (not acceptance evidence):** connected Windows host Obsidian **1.14.4** was started with separate Electron `--user-data-dir` and CDP port 9238; CDP verified the synthetic profile's `app://obsidian.md/starter.html`, while project-local disposable vault/extension assets were staged under `.tmp/ui-acceptance-20261010-vault`. The OS folder-picker flow could not complete reliably because native-dialog execution blocked CDP and window foreground ownership changed; the isolated app exited/restarted. **No plugin Settings, Sync Center or modal was actually observed/render-tested.** The separate user's Obsidian vault was not accessed or modified. Native screen/keyboard/mobile smoke remains OPEN; do not count app launch as a UI pass.

### Audited surfaces with no new confirmed defect so far

- secret migration/persistence: raw token/passphrase are removed before plugin data persistence and use Obsidian SecretStorage;
- debug payload/logging: sensitive key redaction, recursive error sanitization, cycle/depth bounds are present;
- GitHub mutation retry policy: reachable-ref mutations are not blindly retried after unknown outcomes;
- publication reconciliation: ancestry work is bounded and fails indeterminate rather than claiming success;
- request scheduler/transport policy: read/write concurrency and rate-limit waits are bounded/abortable;
- local release publication tooling: canonical repo checks, create-only stable refs, ambiguous-state reconciliation, exact asset set/size/hash verification, and temp-ref compare-delete are present;
- workflows: Actions are SHA-pinned, CI uses read-only contents permission, and the legacy Actions stable-release path remains intentionally interlocked;
- local target preconditions still use size+mtime at final mutation boundaries, but authoritative local discovery no longer treats matching size+mtime as content identity; the remaining narrow TOCTOU window is guarded by source hashing/stability where content is read and remains a residual OS/filesystem race rather than the previously confirmed full-scan blind spot;
- recovery payload path/ID/stage/precondition validation is now enforced on both save and load; remaining header-field tightening is low-priority local-state hardening rather than a confirmed destructive path;
- retired encrypted key material is best-effort zeroized on runtime disposal, but resolved keyrings invalidated by settings changes may remain in the cache's retired set until disposal. Immediate zeroization is intentionally not changed yet because history work exists outside the sync coordinator and can hold a live keyring reference; settings-generation guards now stop stale history results, but tighter reference-counted key lifetime remains a residual hardening opportunity. (full path/duplicate-ID/numeric validation), but header integrity and normal writer ownership mean no equivalent concrete production corruption path is confirmed yet.
- Obsidian `requestUrl` buffers HTTP response bodies before the V4 reader can inspect expected descriptor/tree sizes. Git/V4 integrity checks and read concurrency still fail closed after receipt, but a forged unexpectedly large remote blob can create transient peak memory above the writer contract before rejection. A meaningful fix requires a streaming/bounded transport API; a post-allocation size check would not solve the peak-memory risk and is intentionally not presented as mitigation.
- Remote metadata/history fields still rely partly on transport size plus post-parse writer-shape validation rather than one universal pre-parse byte/string ceiling. This pass specifically reviewed journal bytes and `fileId` length; no new cap was added because the current writer contract does not define a portable total-path/metadata-byte maximum and tightening arbitrary string lengths could reject existing V4 data. Treat this as protocol/resource-hardening design work, not a confirmed destructive bug in this pass.
- `createGitTree()` still validates general successful tree mutation responses primarily as Git object IDs rather than proving full semantic equivalence to `base_tree + requested edits`. Blob creation and commit creation are bound to their intended bytes/semantics, and the special empty-repository bootstrap tree now has its own exact bounded two-level proof, but general candidate-tree equivalence still needs authenticated Merkle/path reconstruction of the base and result. A naive recursive-tree comparison would add large-repository cost and can itself encounter truncated tree responses, so do not add a broad recursive scan merely to close this residual; design a bounded exact-tree proof first.

- Supply-chain review: the repository has no runtime npm dependencies; build/test dependencies are lockfile-managed. `esbuild ^0.24.2` is in a known affected range for dev-server advisories (including the historical cross-origin dev-server issue and a Windows servedir file-read issue), but this repository's `esbuild.config.mjs` uses only `context().watch()/rebuild()` and never starts `serve()`. Treat esbuild `0.24.2` as a dev-tooling hygiene residual, not a production/runtime blocker. Do not hand-edit the pnpm lockfile; upgrade only with a real pnpm install + build/package verification.
- Repository-host security alert APIs (Dependabot/secret-scanning/code-scanning) were probed through the available GitHub connector but were not readable with the current connector permissions, so this audit does not claim server-side alert dashboards are empty.
### RED regression status

RED tests have now been pushed on the audit branch:
- `494c7c57d86eb3125ccd7b664512a4c57b7e07c8` — local-index cached records can be tampered/omitted while the advertised hash string remains unchanged.
- `88d0dad51c6f7f4a3b6a96a923b5040cc9973e0d` — encrypted remote config KDF/algorithm bounds and remote record numeric/chunk descriptor bounds.
- `ced09a381e8c2f4bd4e2bd772d631117f3807733` — history journal marker/page-count safety.
- `e8268b238fef068a97be4469e5d6777dc3d954d0` — unknown bootstrap outcome plus competitor ref must be a typed bootstrap race.
- `01c6190b6d457e37a1ebed473b7285668f61f650` — reusable active-run cancellation required for settings rotation.
- `89cc24a6664cd4839e8f5e991567cbc653adaf71` — whole-buffer chunk reads must have bounded concurrency.
- `088e3d18cc4e646f095859259a18d09ab03a6d29` — settings UI/main must quiesce the old generation before publishing new settings/client state.
- `83a9044b8047c9a57c8bae6e33878fd3db735037` — freshly fetched remote shard records must match the head's advertised shard hash.
- `ee6640d6fe02f9e493158f3c60e30e026fbd6948` — file-history traversal must have one aggregate journal-read budget, and scheduled intervals must stay within the signed 32-bit timer delay range.
- `8aac1d5bc0b7598dafd25e4302be4035e960ff08` — large coordinator event bursts must not depend on argument-spread limits, and remote history journal changes must be writer-shaped before exposure.
- `1c5ca913938a2df2b8c9a034e21669197531d62f` — successful immutable Git commit/tree reads must be bound to the exact requested object IDs, not merely valid-looking SHA strings.
- `e4c68da4e8f37af14ac1add9a715db201b5f30e0` — successful Git blob creation must return the deterministic object ID of the uploaded bytes.
- `1192a6c12c3900f87290f38a3702e8c4876d2b64` — successful Git commit creation must read back to the requested message/tree/parents before publication.
- `e042790b06fbce6621054a4ab67b3edbdcb6a855` — a successful empty-repository bootstrap commit must still be a root commit rather than silently inheriting a competitor base.
- `26af58a088acca4f39568a645c1e0e00225a7a26` — a successful root bootstrap commit must contain the exact bootstrap marker bytes sent by the client before any configured ref is trusted.
- `103bae04cdebc751d8dd5b367b6e774141291ad8` — an already-existing configured bootstrap branch must point exactly at the verified bootstrap commit.
- `d5cdcd2ecd0424bfc6bff2be0f665a0d8ee79e19` — the configured branch must still point at the bootstrap SHA on the post-create read, not merely on the successful create-ref response.
- `2d3812e6b5010c8296242ac3b5df8c9b2f86394b` — exact bootstrap marker bytes are insufficient if the root/bootstrap-directory tree contains additional entries.
- `79a109603463a56559982d0c071df662db95e2be` — authenticated Contents bytes must still be bound to the exact requested repository path and file type.
- `d578693148d77549a7a3aab779a580daf073345b` — an empty Git repository's documented HTTP 409 configured-ref response must be treated as an absent ref so Contents bootstrap can run.
- `5655f2b3f565bf3b1b8912524b798f76336c2659` — journal capacity must be checkable from the resolved change count before staging or immutable-object upload begins.
- `909c7442c6b6da3aea6f1d8eda9db87a3d657d29` — direct plaintext external reconciliation must not re-download an unchanged blob when authenticated metadata and immutable baseline/current trees prove the blob object ID is unchanged.
- `0b097d3a4334096d90bea438d09d111bb28109f4` — a generic/unavailable any-ref HTTP 409 must fail before empty-repository Contents bootstrap can issue any remote mutation.
- `72529e40a16c1bbe32a02fdeafc936cd4f5050da` — definitive configured-ref create conflicts must reconcile by exact observed SHA instead of failing a benign same-bootstrap race.
- `015df6301bbf264930166ef861075895630099d0` — a valid maximum safe remote generation must reject before any publication side effects because no safe successor generation exists.
- `34bf179` — Force Push must not silently preserve an in-scope remote gitlink while claiming an exact mirror; out-of-scope gitlinks remain preserved by scope.
- `014e073` — a settings save that resumes after plugin unload must not recreate client/runtime timers or publish a new live settings generation.
- `4dce43d` — plaintext external reconciliation must not interpret an in-scope gitlink/submodule as file absence and locally delete the managed path.
- `b7518a4` — plaintext external reconciliation must reject an in-scope Git symlink before its blob payload can be treated as ordinary file content.
- `38f6266` — recovery persistence must reject a valid maximum safe generation before computing or writing an unsafe successor.
- `dd7e97d` — plugin startup must remain inert if unload occurs while settings load or migrated-settings persistence is still awaiting completion.
- `ff149f941c7dbb1b0111baaa7d126af0bfad3226` — unload during startup settings load must not skip durable cleanup of migrated legacy secrets before startup returns.
- `0d7bf41` — malformed persisted settings must be rejected before secret migration can mutate SecretStorage.
- `9bc0fa2` — Force Push must not silently preserve a managed explicit empty Git tree while claiming an exact mirror.
- `2d8d32a` — external reconciliation must not treat a tracked file replaced by a Git directory as ordinary remote absence/local deletion.
- `3526f19` — recovery pulls must remove path-topology blockers before writing a file that replaces a directory subtree.
- `6bbd6f5` — vault file/directory topology conflicts must be classified as local-target changes so recovery can replan safely.
- `39bc40f` — large recovery topology payloads must not use pairwise trash × write scans.
- `af9c879` — complete remote V4 record sets must reject logical file-prefix collisions such as `dir` plus `dir/file.md`.
- `d585a37` — complete remote V4 record sets must reject distinct logical paths that collide under the writer's NFC + case-insensitive canonicalization.
- `e64a7e7` — complete remote V4 record sets must reject file-ancestor topology collisions that appear only after NFC + case-insensitive canonicalization.
- `045a0aa` — plaintext external Git reconciliation must reject portable/canonical file topology collisions before blob reads, local mutation, or replacement V4 metadata publication.
- `5ec2801` — successful Git tree responses must reject incompatible object type / Git mode combinations at the decode boundary.
- `e4f66ff` — plaintext external reconciliation must reject managed explicit empty Git trees before publishing replacement V4 metadata.
- `d7ee3db` — external reconciliation must reject internal V4 subtree tampering even when the advertised head remains unchanged and cached shards could otherwise be reused.
- `6d85a80` — generation-1 publication evidence must not trust a forged plugin marker across a parent that lost the V4 head unless the candidate SHA is the locally verified baseline.
- `f894dcf` — plugin publication classification must not trust valid marker/head progression when the candidate hides managed user-tree edits.
- `3fc0246` — authenticated publication metadata must not be trusted when the changed Git blob body disagrees with the claimed/current record.
- `72b2a79` — publication tree verification must have aggregate read/node budgets rather than recurse without a resource ceiling.
- `10b4aae` — cached remote shards must still be bound to immutable publication-tree evidence before a candidate publication advances trust.
- `9e1c89a` — publication ancestry candidates must share one aggregate semantic tree-read/node budget rather than resetting the limit per candidate.
- `0dd07bd` — repeated ancestry parent SHAs must not amplify CPU through flat-array queue shifting while only one unique commit is inspected.
- `22c359e` — failed settings persistence must scrub newly generated pending credential IDs instead of leaving unreachable durable secret copies.
- `d6588d9` — failed startup legacy-secret migration persistence must scrub only the newly generated migration secret IDs.
- `7cd92e7` — multi-secret migration must roll back earlier/partial SecretStorage mutations when a later write fails.
- `f2d2203` — token and passphrase credentials must not share one non-empty SecretStorage ID at validation or migration boundaries.
- `4d54485` — pending credential cleanup must attempt every unique secret ID before reporting a SecretStorage scrub failure.
- `4a3f112` — successful credential rotation must scrub only superseded IDs after durable settings commit and must preserve IDs reused by the new generation.
- `5361768` — unrelated settings saves must not rewrite unchanged token/passphrase values in SecretStorage.
- `4b76f6c` — encrypted plugin publication classification must not trust content-object mutations when the authenticated record/shard metadata does not authorize that object change.

Refined root-cause design:
- create one canonical shard-record hash function and use it for writer hash creation, remote shard verification, and local persisted-cache verification;
- validate remote config/head/record/history metadata at decode boundaries using writer-compatible limits;
- bound whole-buffer chunk read concurrency even after descriptor validation;
- add coordinator `cancelActive` plus runtime quiesce and make settings publication occur only after the old run is idle;
- unknown empty-repository Contents bootstrap outcomes must replan on newly observed repository state rather than adopt an unproven SHA.

Current execution state supersedes the earlier sandbox/DNS limitation: the connected lnwjud workspace can execute the repository with the exact Node/pnpm toolchain and can fetch/push the audit branch successfully. Hosted GitHub status/check-runs/workflow runs remain separate evidence and must still be checked for the exact pushed SHA before release qualification.

### Production fix status

Root-cause fixes are now on the audit branch:
- `da56f07630a1f388249fc588b246f1a46a7d29bb` — add canonical V4 shard-record hashing helper.
- `378059b94b33dc8b495f0b4810c2b9b4b9219dd2`, `3dba921c263e5098214cb9bad800836c8b817ed9` — validate local cached shard hashes on load and refuse mismatched shard persistence.
- `dcff671b8b09baab72a3ecd580819f1de28d7c76`, `359b873277cfb25456faf1617e76b54c04073472` — writer derives head hashes from canonical records; remote loader verifies both cached and freshly fetched shards against the head.
- `e300fe07983a757d0020cb8fe8c79a18993e1e4e` — unknown empty-repository Contents bootstrap outcomes with newly observed repository state now surface a typed bootstrap race instead of adopting an unproven SHA.
- `88990134ae8e8764e8b8c0696e16c934020727ae`, `aab2e432c74dc7b550455d5300a1a604eaac087f`, `e382e63e085fc196e8015c4dc046a7c1c99e8473`, `a04ba7b4f9b233871328368fbdb58da1591965fa`, `d2a02390b7c725a40f96ebc392153b8a13611fd8` — reusable active cancellation, runtime quiescence, settings publication ordering, and progress cleanup for atomic settings/client generation rotation.
- `f2ad17aef7d833178f7e9ba105489ce6fb6ad999`, `8c6bd38cdb0b9bc3a953a4bc9dcda0734b6bf60b` — encrypted config/KDF bounds plus remote head/record/shard shape/resource validation.
- `ff2780ff1543fde9b3914db174b733a998011f9f` — bound whole-buffer chunk remote reads to four concurrent part fetches.
- `e1173260c083c2be55c4317ed1fec119b90a488f` — remove coordinator argument-spread amplification and validate remote journal change semantics/paths/descriptors before history consumers observe them.
- `8d56b55c130062934ed3850b43dfcb62b462bb69` — bind successful immutable Git commit/tree reads to the exact requested SHA before their evidence is trusted.
- `7cc635aa3ee71bdbe36ddce8a6d7b5017c895f27` — bind successful Git blob creation to the deterministic SHA-1 of the uploaded bytes.
- `ddec918b51d3dc4e0129449b0682487cce1fb126` — validate commit mutation inputs and read the created commit back to bind message/tree/parents before publication.
- `a4f9d5ba5ecd26140cb3a237251aa96939783276` — authenticate successful empty-repository bootstrap as a root commit with the exact bootstrap message before accepting/creating the configured ref.
- `ff4386adeb24f983316872ae99394464b17efad3` — bind successful bootstrap completion to the exact immutable marker bytes that were sent in the Contents PUT before configured-ref adoption.
- `68803e2f8ef1754c5c16dd93cce524f0dae84551` — bind every configured-bootstrap-ref observation to the verified bootstrap SHA, including pre-existing refs, post-create reads, and ambiguous create reconciliation.
- `593657cb7a73b06630a0610f38ba281ea2eaa883` — authenticate the successful root bootstrap commit's exact bounded two-level tree shape and marker leaf identity before configured-ref adoption.
- `0762038ae20673674fceb71376906dd21d1443c4` — stabilize the fast planner qualification by measuring process CPU time instead of wall-clock delay caused by concurrent test files.
- `d957ad1` — bind successful GitHub Contents file responses to `type: "file"` and the exact requested repository path before trusting authenticated payload bytes.
- fixture-only follow-up `a121304` keeps the immutable Contents-success regression protocol-shaped under the stricter response contract.
- `6d3ba0a899214c9b8d0f842ce3a28be14c3a5796`, `4959c07acd5ae6007ec66a925050edcd40bfb76f` — allow only documented empty-repository configured-ref conflicts to reach verified Contents bootstrap while propagating unrelated 409 conflicts fail-closed.
- `647fbeeaade34008162d4382955afc37a787bf09` — preflight the exact resolved journal change count against the shared writer contract before staging or streamed remote uploads can create side effects.
- `48d103dc95b2c75feba43deabf40f56c2305804c` — reuse authenticated plaintext records for unchanged external-tree blobs when the local metadata manifest exactly matches the authenticated remote head, avoiding full-vault blob re-downloads for direct external edits.
- `5d7f4d211d22b73a4383972430ccd6ab4a039c5e` — distinguish explicit empty-repository conflicts from generic/unavailable 409 responses in the any-ref bootstrap preflight so non-empty conflicts fail before Contents mutation.
- `5ed8abe` — reconcile definitive 409/422 configured-ref create conflicts only when read-back proves the ref points exactly at the verified bootstrap commit; competitor SHA remains a typed bootstrap race.
- `b10522ea4e2fd2f942afd3cbca1ea0ed971b4da3` — guard max-generation remotes at the publication boundary so no unsafe successor head or remote publication side effects can be created.
- `620c3bb` — fail closed when an in-scope remote gitlink/submodule prevents Force Push from proving an exact managed mirror; preserve out-of-scope gitlinks.
- `d8c3c6b` — keep late settings-save completion inert after plugin unload and prevent scheduled sync registration from recreating timers on a disposed plugin.
- `fe8b8e7` — reject managed external plaintext gitlinks/submodules before they can be misclassified as remote deletions; preserve out-of-scope gitlinks by scope.
- `ed76ca7` — reject managed external plaintext symlinks and unsupported blob modes before body reads or local planning; preserve out-of-scope objects by scope.
- `2d00466` — fail closed before recovery encryption/write when the current valid recovery generation has no safe successor.
- `df2bc0a` — make async plugin startup stop after unload at both settings-load and migrated-settings-persistence boundaries before recreating runtime work.
- `78ba901` — persist migrated legacy-secret cleanup before the startup unload guard while keeping all runtime/UI/timer creation behind that guard.
- `2279fa9` — validate merged persisted settings before `migrateV4Secrets()` can write SecretStorage, while retaining post-migration runtime validation.
- `37f5f55` — fail closed on managed explicit empty Git tree entries during Force Push while preserving non-empty and out-of-scope directories.
- `1613d05` — fail closed when external plaintext reconciliation replaces an authenticated tracked file path with a Git directory before local deletion can be planned.
- `ffb71e0` — topologically order recovery trash/write mutations and make the Obsidian vault adapter replace only empty target folders when a file must occupy that path.
- `be6fcf8` — classify non-empty-folder and file-as-parent vault topology conflicts as local-target changes so recovery enters replan-required instead of hard-failing.
- `235fb98` — replace quadratic recovery trash/write topology scans with exact-path/ancestor set lookups plus sorted-prefix binary search.
- `5b78259` — reject complete remote V4 record sets where one logical file path is an ancestor of another before planning or local mutation.
- `ce673e9` — reject authenticated remote logical path sets whose distinct names collide under NFC + case-insensitive canonicalization.
- `9bf77af` — reject authenticated remote file-prefix topology collisions across NFC/case variants by walking the canonical path set.
- `b2f75c7` — reuse the complete path-set validator for external Git preflight, then validate the fully reconciled plaintext record set before installing it into remote state.
- `27eb8eb` — bind Git tree entry modes to their canonical object types before any downstream consumer trusts the tree evidence.
- `77ed62b` — reject managed explicit empty Git trees during plaintext external reconciliation using the same bounded descendant proof as Force Push.
- `c32c886` — verify external publication ancestry against exact immutable V4 head evidence and require the external tip to preserve the verified V4 root tree before reconciliation.
- `8e91084` — verify candidate plugin-publication user-tree changes against authenticated parent/current records and bind locally matched plaintext bytes to the changed Git blob object ID.
- `1c9b6f5` — bound non-recursive publication-tree verification to 4,096 reads and 250,000 decoded nodes, failing closed on truncation or budget exhaustion.
- `5104c91` — bind cached shard reuse to unchanged immutable shard blob SHAs between the trusted baseline and candidate publication tree.
- `645ba05` — share one publication-tree verification budget across every ancestry candidate and its cached-shard/tree-consistency sub-checks.
- `e7beb37` — traverse publication ancestry parent lists without copying/shift-based flat queues, preserving BFS and the 256-commit limit while bounding duplicate-parent CPU cost.
- `e838aad` — scrub only newly generated pending SecretStorage IDs when settings persistence fails, preserving the previously committed credential references.
- `d00d8d4` — track startup migration-created secret IDs and scrub them if migrated-settings persistence fails, without touching pre-existing secret references.
- `a8fe164` — make `migrateV4Secrets()` transactional across partial SecretStorage write failures by restoring previous values or scrubbing newly generated IDs before rethrowing the original error.
- `9c00d2c` — reject aliased token/passphrase SecretStorage IDs through one shared invariant at runtime validation, migration, and persistence helpers.
- `7ac4fc6` — scrub all unique pending credential IDs best-effort before surfacing cleanup failure in startup-migration and settings-save rollback paths.
- `49b7ac2` — scrub superseded credential IDs only after durable settings commit, excluding any ID still active in the new generation.
- `fa6a36a` — write only changed credentials during settings save by threading the pending-credential selection into `storeV4Secrets()`.
- `135b961` — bind encrypted publication object changes to authenticated parent/current record descriptors and immutable tree evidence; fully verify changed shared packs within the writer pack-size contract.
- `6151868d066c050deef9159d3beda389e2ae0ce7`, `d9cde1a72496a8c86df5c85b975d39b92998f873`, `0c301523e774d54bc03191aa7a897da98691ac81`, `06335328777bd5010e928c1951f1cdb581aac2f0` — bounded journal writer/reader contract, safe journal markers, cross-page consistency, descriptor validation before blob reads, and preview-limit precedence.
- fixture-only followups `4ce0affffce484398db30b0de339af8a2dd1e5cf`, `e5ae96eda6003faa4233346bd5104561e2258923`, `40fc418844c40a52ef4baa39c7318f21a5547782`, `b876e4076084e544ec13ec0ef60c9ef7e0cbcc8a` keep tests protocol-shaped rather than weakening production validation.
- fixture-only follow-up `b7635b7` makes recovery Git fixtures honor immutable ref reads and model non-recursive tree evidence under the publication-tree verifier; production behavior is unchanged.

Recent crash/memory hardening:
- `99f8e793...` / `e2d9dae3...` — interrupted desktop staged swaps become resumable.
- `d49bb3c8...` — large chunked conflict copies stream directly into staging.
- `82efe37c23094d20aeb348a2f93be7b1ede50a38` — final desktop staged-target hash verification re-runs vault path safety before bounded reads, in addition to the cache/staged-copy fixes above.

Verification status:
- The repository was executed through the connected local engineering workspace with Node `v24.11.0` and pnpm `9.12.3`.
- Final post-fix gates on the current production source: `pnpm run test:fast` **547/547**, `pnpm run test:recovery` **50/50**, `pnpm run test:resource` **15/15**, and `pnpm run build` PASS.
- Final release checks also pass on regenerated artifacts: `pnpm run validate:metadata` and `pnpm run validate:package`.
- After publication-tree hardening exposed stale recovery fixtures, `b7635b7` restored the recovery gate to **50/50** by removing immutable-ref fallback to the mutable tip and supplying protocol-shaped non-recursive tree evidence.
- The 547/547 fast run was executed with one unrelated uncommitted test-only helper in `tests/v4/github-transport.test.ts`; it does not modify production source or add/change a test case. Do not describe that run as a pristine exact-Git-tree qualification until that concurrent WIP is committed or removed.
- Focused regressions in the latest audit pass: settings-secrets **62/62**, sync-session **113/113**, remote-index **20/20**, recovery **50/50**, recovery-boundary **3/3**, recovery-topology-ordering **1/1**, publication-tree-budget **3/3**, vault-write **3/3**, github-bootstrap-ref-conflict **2/2**, github-empty-ref **3/3**, github-transport **43/43**, github-tree-mode-validation **1/1**, storage-history **4/4**, github-immutable-read-fallback **13/13**, and benchmark **3/3**; publication-race **1/1** and runtime-retry **1/1** also pass with the stricter non-recursive tree evidence model. The benchmark qualification also reproduced the prior wall-clock flake under full-suite contention before `0762038...`, with later full fast runs remaining green through the current **547/547** audit head. Prior history-service **13/13**, sync-coordinator **25/25**, sync-policy **2/2**, storage-codec **12/12**, and opaque-leakage **2/2** remain covered by the full fast gate.
- Real GitHub E2E remains excluded from the default fast tier and was not run in this closure; inspect hosted checks for the exact pushed SHA separately before treating the branch as release-qualified.

2026-10-10 release-readiness follow-up on audit source tip `ccc3ebc5e1cf2e707c1c9e885447421e6ffc580f` (before the documentation-only handoff update):
- Connected `lnwjud` Windows workspace: `corepack pnpm install --frozen-lockfile`, `corepack pnpm build`, `corepack pnpm test:fast`, `corepack pnpm test:repeat` (all 10 rounds), `corepack pnpm test:recovery`, `corepack pnpm test:resource`, `corepack pnpm test:feasibility`, `corepack pnpm validate:metadata`, `corepack pnpm validate:package`, and `corepack pnpm test:github-e2e:compile` all completed with exit code 0. These were executed as separate non-destructive local gates, not official exact-SHA qualification.
- The fast/repeat runs included an **uncommitted, pre-existing test-helper edit** in `tests/v4/github-transport.test.ts`; the current workspace is not a pristine exact-SHA checkout and this WIP was deliberately left untouched and unstaged.
- The review/qualification matrix and maintainer decision boundaries are recorded in `docs/engineering/production-release-readiness-2026-10-10.md`.
- Release blockers remain: independent review of draft PR #8, a clean frozen `master` SHA and hosted CI, disposable-repository live E2E with verified cleanup, physical platform smoke evidence per published support claims, and exact-SHA local qualification before any stable publication. No destructive live test, tag, release, or merge was performed.
- Hosted GitHub Actions check on 2026-10-10: after pushing readiness docs as `3886c33f6810eb95a37046ed585bd90fc6640aff`, the repository Actions runs API returned `total_count: 0` for that SHA; the newest repository-wide runs visible through the public API dated 2026-08-16. Root cause not determined; do not claim Actions are disabled or that hosted CI passed. Investigate repository Actions settings/workflow eligibility before using hosted qualification evidence.
- Release-host preflight: connected Windows workspace returns `node --version` = `v24.11.0` and `corepack pnpm --version` = `9.12.3`, but `gh` executable was not found when attempting read-only `gh api`. Local official qualification/release is therefore blocked **on this host** until an authenticated GitHub CLI is provisioned; no global tooling changes were made.
- Do not automatically promote audit-branch gates to release authority: after merge/version changes the target SHA must be requalified.
- Follow-up clean-tree proof: a detached Git worktree at `.tmp/release-audit-clean-20261010` was checked out at exact full SHA `f6e7ab5130095da72f9fe41a23887fa1f8bdfb05`; Git status was clean before **and after** testing. Frozen install, build, fast once, repeat fast 10/10 complete, recovery, resource, feasibility, metadata/package validation, and all three E2E harness compile bundles each passed with exit code 0 using the pinned Node/pnpm. This excludes the unrelated dirty transport fixture from the primary workspace, superseding the non-pristine evidence caveat **for this clean audit SHA only**. No live E2E, physical device test, official qualification receipt, or stable release was created.

### 2026-10-10 UX/UI/performance/rare-case follow-up verification

- Root-cause fixes and RED/GREEN regressions committed and pushed as **`bc61530`** (`fix: harden settings save UX and history previews`). This audit keeps unrelated GitHub-transport helper WIP unstaged.

- The traced risk matrix, three reproduced defects, bounded fixes, and remaining non-confirmed UX/performance hypotheses are recorded in `docs/engineering/production-ux-edge-audit-2026-10-10.md`.
- RED → GREEN suites: Settings Save overlap/UX/failure handling **4/4**, Sync Center provider error and lifecycle **8/8**, and history-service suite including unknown/oversized external blob size preflight **PASS**.
- Connected `lnwjud` Windows run: `pnpm build`, `pnpm test:fast`, `pnpm test:repeat` (10/10), `pnpm test:recovery`, `pnpm test:resource`, `pnpm test:feasibility`, `pnpm validate:metadata`, `pnpm validate:package`, and `pnpm test:github-e2e:compile` (three bundles) each exited 0. The final fast-repeat gate was rerun after the additional quiescence-error regression was added.
- This qualification runs in the existing audit workspace containing the **unrelated, pre-existing, unstaged** `tests/v4/github-transport.test.ts` helper edit. Do **not** call it a pristine exact-Git-tree run. The previous separate clean detached audit-SHA evidence applies to its own earlier source, not to these new fixes.
- Additional **pristine exact-source** verification: detached worktree `.tmp/release-audit-clean-20261010` at full SHA `bc6153061e3222d3c386f466e864df9fc171ed39` (pushed fix commit) was clean both before and after every gate. Exact Node `v24.11.0` / pnpm `9.12.3`: `corepack pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test:fast`, `pnpm test:repeat` (10/10), `pnpm test:recovery`, `pnpm test:resource`, `pnpm test:feasibility`, `pnpm validate:metadata`, `pnpm validate:package`, and `pnpm test:github-e2e:compile` all exited 0. This clean-run evidence **supersedes the WIP caveat for that exact code SHA**, but is not an official `master`/live qualification receipt.
- No destructive live GitHub E2E, physical-device qualification, stable release/tag publication, or PR merge was performed; those release gates remain open. Ordinary audit branch commits/pushes are tracked separately.

### 2026-10-10 event-burst performance follow-up

- Additional confirmed finding **113** is fixed in `src/lib/v4/sync-coordinator.ts` and `src/lib/v4/runtime.ts`; a RED/GREEN 300-event regression in `tests/v4/settings-secrets.test.ts` proves progress coalescing is not requested more than 128 times per debounce burst and that all 300 events remain present for final exact coalescing.
- Connected `lnwjud` Windows verification after this change: `pnpm build`, focused settings-secrets **63/63**, `pnpm test:repeat` **10/10**, `pnpm test:recovery`, `pnpm test:resource`, `pnpm test:feasibility`, `pnpm validate:metadata`, `pnpm validate:package`, and `pnpm test:github-e2e:compile` all returned exit code 0.
- These pre-commit checks ran in the audit workspace alongside the **unrelated and unstaged** `tests/v4/github-transport.test.ts` helper WIP. They are not clean exact-SHA qualification and are not a substitute for live E2E or physical device performance measurements; re-run a clean detached-SHA gate before promoting evidence.

- Post-fix **clean exact-audit-SHA** verification: detached worktree `.tmp/release-audit-clean-20261010` checked out full `d108498252704946ee0f2c33cfc59e13d6323efe`, clean Git status after the tests (`## HEAD (no branch)`). With Node `v24.11.0` / pnpm `9.12.3`, frozen install, build, standalone fast, repeat fast **10/10**, recovery, resource, feasibility, metadata/package validation and three GitHub E2E harness bundles' compile-only checks all returned **exit code 0**. The unrelated dirty transport fixture remained only in the primary workspace and was not part of this source. No live remote mutation, physical-device proof or exact-`master` official receipt was created.

### 2026-10-10 Settings clipboard and hidden-view race follow-up

- Newly proved and fixed findings **114–115**; source and focused RED/GREEN evidence are in `docs/engineering/production-ux-edge-audit-2026-10-10.md`.
- Pre-commit `lnwjud` Windows: `pnpm build`, `pnpm test:fast`, `pnpm test:repeat` **10/10**, Settings Save **6/6**, Clipboard Lifecycle **4/4** all completed with exit code 0.
- The main audit workspace retains the **unrelated pre-existing** unstaged `tests/v4/github-transport.test.ts` helper edit. Therefore these pre-commit test results are not yet exact-source clean checkout proof; separately validate the pushed fix SHA in a detached worktree.
- No real-GitHub credentials, force operations, destructive E2E, physical device tests, PR merge or production release were used.

- Source fixes/tests/release-readiness audit from this phase committed and pushed as `d8d7d83e21c22ecbc2111887e4b25ca8aa406d8a`. **Clean exact-source** detached worktree at that SHA was clean before/after checks; Node `v24.11.0`, pnpm `9.12.3`: frozen install, build, fast, repeat fast **10/10**, recovery, resource, feasibility, metadata/package validation, and E2E compile-only (three bundles) all exited 0. Unrelated dirty transport helper in primary workspace was excluded.
- **Deferred accessibility/product decision:** `FastSync.showForceConfirm()` uses a pointer-only div slider without an evident keyboard unlock, focus target or slider ARIA semantics. A deliberate keyboard-accessible path must be designed and verified in real Obsidian without weakening destructive-operation confirmation. Also decide warning-only versus blocking Sync/Force while settings are unsaved. Neither interaction was changed in this patch.
- Live destructive GitHub E2E, physical platform smoke, and stable release qualification remain unexecuted.

### 2026-10-10 comprehensive UI source audit verification

- Enumerated **all plugin UI surfaces** across Settings General/Connection/Encryption/Manual/Automation/Support; Sync Center Commit/Current File/Detail/Preview/Progress/empty/errors; Ribbon; Status Bar; Command Palette; Force/Conflict/threshold dialogs; Notices; responsive CSS and accessibility. Detailed pass/evidence/remaining-visual matrix: `docs/engineering/full-ui-surface-audit-2026-10-10.md`.
- Confirmed RED/GREEN findings **116–120** and fixes. Focused UI tests: stylesheet contract **4/4**, Sync Center **11/11**, Status Bar **3/3**, Copy Debug **2/2**.
- Connected `lnwjud` Windows engineering workspace with Node `v24.11.0` / pnpm `9.12.3`: `pnpm build`, `pnpm test:fast` **571/571**, `pnpm test:repeat` **10/10**, `pnpm test:recovery`, `pnpm test:resource`, `pnpm test:feasibility`, `pnpm validate:metadata`, `pnpm validate:package` and `pnpm test:github-e2e:compile` (three bundles) each exited 0.
- During the first repeat run a prior source-text regression required the existing status-bar `if (runtime && !runtime.isSyncing)` guard structure; that original guard was preserved inside the shared keyboard/pointer handler and full fast + repeat were rerun GREEN. This is a test-shape compatibility adjustment with no weakened runtime semantics.
- **Not pristine yet:** primary workspace still contains unrelated uncommitted `tests/v4/github-transport.test.ts` test-helper changes; these gates are pre-commit, not clean exact-source qualification. After pushing fix commit, test the exact code SHA from a separate detached clean checkout and record results.
- Real native Obsidian visual acceptance was **not** performed, because the only existing Obsidian window is associated with a separate user vault; we did not open, edit or capture unrelated private vault screens. Physical desktop/mobile, keyboard modal accessibility and hosted CI evidence remain required before release.

- Comprehensive UI source-audit implementation/report committed and pushed as `13dce59e3364ae7ec360c35435f074115bf3628a`. **Clean exact-SHA proof:** detached `.tmp/release-audit-clean-20261010` checked out precisely that full SHA, `git status --short --branch` returned `## HEAD (no branch)` after testing. Node `v24.11.0` / pnpm `9.12.3`: frozen install, production build, standalone fast **571/571**, repeat **10/10**, recovery, resource, feasibility, metadata/package validators, and three E2E harness compile-only bundles all exited **0**. The unrelated dirty `tests/v4/github-transport.test.ts` helper remained only in the primary workspace, not this clean source.
- **No physical visual validation:** report is an exhaustive *source surface inventory and deterministic interaction check*, not an Obsidian screen-by-screen screenshot/test on this SHA. Actual vault and keyboard/mobile acceptance remain open, particularly accessible Force confirmation.

- 2026-10-16 high-confidence build fix pushed as `0216bc5` and Windows LF stabilization `dccc9eaa8b6328dffd28f2aa1998a1decb46dc5a`. In a detached **clean exact-SHA** checkout, frozen install, build (including generated Sass CSS), fast, repeat **10/10**, recovery, resource, feasibility, metadata/package validators, E2E compile-only all exited 0; final `git status` was exactly `## HEAD (no branch)`. Complete Sass output equals committed `styles.css`, and build does not dirty Windows checkout after `.gitattributes` pinned LF. Prior css selector-presence tests had masked nontrivial SCSS/CSS differences. Focused stylesheet contract **6/6**.
- A disposable vault remains staged entirely within `<repo>\.tmp\ui-acceptance-20261010-vault`, with separate Obsidian 1.14.4 Electron profile. Native vault folder picker/desktop foreground interaction prevented completing the Obsidian plugin UI smoke. **Do not claim app UI verified**; follow up with controlled isolated vault acceptance, screen captures and accessible Force confirmation while preserving the user's main vault.

### 2026-10-16 real Obsidian UI screenshot harness and visual findings

- The new `pnpm test:ui:visual` / `scripts/run-ui-screenshots.mjs` starts **real Obsidian 1.14.4 Windows** with an isolated Electron profile and synthetic vault strictly under `<repo>/.tmp`. It refuses non-project/symlink paths, checks actual vault path and empty GitHub coordinates/token, enables community plugins only inside that profile, waits for first-run initialization, captures Settings' **separate popout CDP page**, History/Current File, and locked Force Push/Pull confirmations. It only invokes modal Cancel, not Force. Fresh `--launch` with profile/port 9250 **passed 29 checks and wrote 12 PNGs**, zero observed JS exceptions; selected screenshots are committed at `docs/engineering/ui-real-screenshots-2026-10-16/`. Runner report is under `.tmp/ui-visual-smoke-new/screenshots/report.json` (ignored).
- **UI-122 confirmed MEDIUM, fixed with RED/GREEN and real screenshots:** 276px sidebar grid incorrectly rendered 220px+300px columns causing clipping. Container query now stacks master/detail when sidebar is narrow; real DOM measured `detailRight=layoutRight=1012px` after change.
- **UI-123 confirmed LOW, fixed with RED/GREEN and real screenshots:** repeated history errors spawned toast overlays over Sync Center heading and actions even though the error was visible inline. Keep only inline error.
- **UI-124 OPEN:** 375px CDP desktop Settings leaves only 175px actual plugin form content because native Settings navigation still shows; this is not physical mobile support evidence.
- **UI-125 FIXED for unconfigured GitHub:** missing saved owner/repo/token now shows a setup Notice without creating a Force modal, verified RED/GREEN for all 6 missing-field/operation combinations and real Obsidian screenshot smoke. **P1 still OPEN** for the pointer-only slider when a real target is configured; do not weaken destructive-action safety without an equally deliberate accessible confirmation design.
- Detailed reproduction, screenshots and usage: `docs/engineering/real-obsidian-ui-visual-evidence-2026-10-16.md` and `docs/engineering/full-ui-surface-audit-2026-10-10.md`. No real GitHub E2E, destructive action, or physical mobile check was done.

### 2026-10-16 follow-up — visual runner safety and unconfigured Force

- Real Windows Obsidian Desktop 1.14.4 smoke script `scripts/run-ui-screenshots.mjs` now creates a **fresh unique** `.tmp/ui-visual-smoke/runs/<id>/` vault and Electron profile for each `pnpm test:ui:visual`. Launch refuses pre-existing folders; attach requires an exact marker created by this runner, checks for symlink/junction paths and confirms the live vault matches the requested project-local path before any plugin file replacement. A dedicated `tests/v4/ui-visual-smoke-cli.test.mjs` covers out-of-project vault rejection, invalid port, refusing existing vault, and refusing missing marker (**4/4**).
- Confirmed UI-125 via physical screenshots: unconfigured Force Push/Pull formerly showed `Repository: /` and a pointer-only unlock slider. `src/main.ts` now rejects missing saved GitHub owner, repo or token with a setup Notice and **no Force modal**, without initiating remote action. `tests/v4/force-unconfigured-ui.test.ts` confirmed RED → GREEN over six combinations. The visual runner verifies no destructive confirmation appears and captures after-fix screenshots for both actions.
- A subsequent **fresh real-app run** of `corepack pnpm test:ui:visual` passed **27 assertions, 12 screenshots, zero observed JS exceptions**, with only the known **175px desktop Settings viewport at emulated 375px** remaining as a warning. Count differs from the initial 29 because old locked-modal checks were replaced by explicit no-modal safety checks. Evidence and old-vs-new screenshots: `docs/engineering/real-obsidian-ui-visual-evidence-2026-10-16.md`. The latest runner closes **only the Obsidian process it launched** after capturing; host check found zero remaining Obsidian processes from that isolated invocation.
- **Release acceptance remains OPEN:** no authenticated/destructive GitHub E2E, physical Android/iOS, full real light/dark theme comparison, keyboard/screen-reader-safe configured Force confirmation, or hosted CI qualification. Do not merge PR #8 or publish stable release solely on screenshot smoke evidence.
- Primary repo still includes unrelated unstaged `tests/v4/github-transport.test.ts` WIP. Never stage/revert it. Qualify the exact pushed code SHA on the separate clean detached worktree after commit and record gates.

- **Exact-SHA UI acceptance evidence (follow-up):** code commit `216af46d812802811e2c8d2c32cfc39fe3c0ae6e` (pushed on Draft PR #8), verified in **detached clean checkout** `.tmp/release-audit-clean-20261010` with frozen install, Production Build, Fast Tests, Repeat **10/10**, Recovery, Resource, Feasibility, Metadata/Package and three E2E harness compile-only bundles all exiting 0. Crucially, `corepack pnpm test:ui:visual` also launched **real Obsidian 1.14.4**, passed **27 assertions**, captured **12 PNGs** and observed no JavaScript exceptions from the exact same code SHA. Post-test Git status: **`## HEAD (no branch)`**. Source worktree still preserves the unrelated unstaged `tests/v4/github-transport.test.ts` helper WIP.
- Remaining non-claims unchanged: no physical Android/iOS visual acceptance, actual GitHub live E2E mutation, fully keyboard-accessible configured Force slider, native all-theme/locale matrix, merge or release approval. Baseline and after-fix real-screen captures linked from `docs/engineering/real-obsidian-ui-visual-evidence-2026-10-16.md`.

- **UI-126 — MEDIUM screenshot-integrity gate fixed:** Prior 375px full-window simulation shoved the Sync Center right dock offscreen yet saved a small valid PNG, falsely marking it as visual evidence. Added `scripts/ui-visual-assertions.mjs` to require visible target bounds, valid PNG headers/dimensions and DPR-aware actual clip-size checks. The runner now waits for a *fully rendered* Obsidian workspace (not just `app` API boot) and captures a **real on-screen narrow sidebar crop** instead of an empty viewport image. Focused pure regressions **4/4**; `pnpm test:ui:visual` invokes all **8/8** UI preflight tests before build. Real Windows Obsidian 1.14.4 rerun: **43 checks, 12 images, 0 observed exceptions**. New screenshot committed under `docs/engineering/ui-real-screenshots-2026-10-16/09-sync-center-narrow-dock.png`; verified visually and report updated. **CDP-emulated 375px desktop Settings** still has only 175px usable form width; not a mobile pass.

- **Clean exact-SHA verification for UI-126:** code SHA `620c103b59d46b110bb2ffd8c7e75b988a304043` pushed to audit branch, then checked out in detached `.tmp/release-audit-clean-20261010`. Frozen install, build, Fast, Repeat **10/10**, Recovery, Resource, Feasibility, metadata/package validators, GitHub E2E compile-only, and real Obsidian `test:ui:visual` all exited **0**. Real screenshot run: **8 unit/CLI checks, 43 native checks, 12 images, 0 observed exceptions**, one still-open 375px Settings warning. Screenshot of 300px real dock is **450×1143 physical pixels** at 150% DPI, reviewed. Post-gates `git status --short --branch` exactly `## HEAD (no branch)`. The unrelated primary-worktree GitHub transport helper remains unstaged and excluded. PR #8 stays Draft, no live destructive E2E/merge/release.

- **2026-10-17 first authorized LIVE GitHub E2E — PASSED:** maintainer authorized destructive tests in the prearranged disposable repo `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform`. Authenticated GitHub API proved target numeric ID `1284153873`, different from canonical source `1282135059`, default branch `main`, and `e2e-destructive` absent before mutation. Clean detached code SHA `3cf17bdbf3f22854356074ec10bb2ecdeb9e0f7f` ran `corepack pnpm test:github-e2e` with expected/source IDs supplied as **process-only** environment variables (the ignored `.env.github-e2e` lacked required `GITHUB_E2E_EXPECTED_REPO_ID`). Runner completed **exit 0, no stderr** in ~12m25s. **Two later authenticated API checks** confirmed the target ID unchanged and disposable branch **absent after cleanup**. Tool log was truncated (~3.8 KB), so do not claim exact count of individual passing cases; retain precise distinction from real native Obsidian UI. Attempt to edit the secret file was denied (`SECRET_ACCESS_DENIED`), respected; user must **manually add `GITHUB_E2E_EXPECTED_REPO_ID=1284153873`** for future default runs. Evidence: `docs/engineering/live-github-e2e-2026-10-17.md`. PR #8 remains Draft; no merge/release or source default-branch mutation.

- **UI-127 HIGH — REAL Electron desktop I/O failure FOUND and FIXED, native network/UI now proven:** authorized pinned-ID repo `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform` (ID `1284153873`) and fresh random `obsidian-sync-e2e/local-* `branch only. The first **two actual Obsidian** plaintext startup Force Push attempts failed at `hashing` with `Failed to fetch dynamically imported module: node:fs/promises`, despite protocol-level Node E2E passing. Production `src/lib/v4/platform-io.ts` needed **CommonJS `require("node:fs/promises")` / `require("node:path")` inside Obsidian**; Node ESM bundles need their dynamic import path. RED built-bundle regression, first fix failed ESM (dynamic require shim), then green with `typeof exports === "object"` conditional. Code SHA **`464800d016682e49fc6dc1ef8645335f319d50ef`**, pushed. Clean detached checkout: frozen deps already installed, build, Fast, Repeat **10/10**, Recovery, Resource, Feasibility, Metadata/Package, E2E compile-only all exit 0; `git status --short --branch` exactly `## HEAD (no branch)`.
- **Actual native Obsidian → GitHub UI roundtrip PASSED at that clean SHA:** independent read-only target repo ID/default branch and randomly generated branch-absence preflight; spawned isolated Obsidian 1.14.4 and synthetic vault under `.tmp`; configured plugin in isolated vault (no startup/auto sync); `forcePush(false)` initialized newly generated branch; synthetic note modified through `app.vault.modify`; clicked **Sync Center → Sync now** in Electron DOM; Progress reported **success / normal / manual, Push 1/1, 11.3s**; GitHub API confirmed branch HEAD advanced; screenshot visually reviewed and stored as `docs/engineering/ui-real-screenshots-2026-10-17/12-live-github-sync-center-success.png`; tool exit 0, `uiExceptions=0`, `remoteHeadChanged=true`, `cleanup=absent-verified`. A **second independent API lookup** checked target ID `1284153873`, default `main` and the unique test branch `obsidian-sync-e2e/local-464800d01668-548833738e948b7f` **absent**. The runner wipes the temporary test vault/profile including credentials on shutdown. Evidence: `docs/engineering/live-obsidian-github-ui-e2e-2026-10-17.md`. **NO merge/release**, PR #8 stays Draft. Outstanding native encrypted roundtrip, keyboard/screen-reader configured Force confirmation, Android/iOS, CI/master qualification.
- **Credential management:** ignored `.env.github-e2e` is secret-protected and lacks pinned expected ID; continue supplying `GITHUB_E2E_EXPECTED_REPO_ID=1284153873` and source ID `1282135059` **only to child process** after independent remote lookup, or request maintainer to manually add the pinned IDs to their local secret file. Never display/commit token, never bypass secret access denial. Primary unrelated `tests/v4/github-transport.test.ts` WIP remains unstaged and untouched.

- **2026-10-17 encrypted native UI GitHub roundtrip — PASS after cleanup gate fix:** Explicitly authorized disposable target `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform`, pinned ID `1284153873`; source SHA `3c1af51856928d29addaa0946b359329ce7fad11` checked out in clean detached `.tmp/release-audit-clean-20261010`. Strict `--mode=encrypted` generates a fresh random passphrase for an isolated Obsidian 1.14.4 vault/profile, performs an encrypted first Force Push on an absent random branch, modifies a note and clicks the actual Sync Center **Sync now** action, then checks GitHub HEAD advanced. Authenticated read-only GitHub tree/blob checks confirmed encrypted mode, `opaque-stable-v1` layout, `AES-GCM`, opaque `.enc` object name, OGS4 blob header, absent plaintext note path and absent sample note contents in ciphertext. Screenshot inspected: **Success / Normal / Manual, Push 1/1, Encryption phase**, 11.4s. Runner returned **exit 0, remoteEncryptionVerified=true, remoteHeadChanged=true, uiExceptions=0, cleanup=absent-verified**. Separate GitHub read-only check independently confirmed the exact branch absent and repo ID/default branch unchanged. Windows process/filesystem check confirmed **no test Obsidian processes and no residual isolated vault/profile folder**. Evidence: `docs/engineering/live-obsidian-encrypted-github-ui-e2e-2026-10-17.md`, screenshot `docs/engineering/ui-real-screenshots-2026-10-17/13-live-encrypted-github-sync-center-success.png`. No real mobile or native second-device decrypt/restore proof yet.
- **Windows profile cleanup regression found/fixed:** first encrypted native attempt succeeded on remote assertions but returned **exit 1** because transient Windows profile lock made `fs.rm` fail; cleanup was retried later successfully. Added fail-closed scoped `scripts/obsidian-live-ui-cleanup.mjs` (delete only `<repo>/.tmp/obsidian-live-github-e2e/<16 hex>`, bounded retries on EBUSY/EPERM/EACCES/ENOTEMPTY) and `tests/v4/obsidian-live-ui-cleanup.test.mjs`; strict encrypted-mode/opaque-tree validations in `scripts/obsidian-live-ui-mode.mjs` and tests. RED/GREEN focused tests **9/9** on clean source; code commits `33f86c4` and `3c1af51` pushed. Exact-SHA production build, `test:repeat` **10/10**, `test:fast`, Recovery, Resource, Feasibility, Metadata/Package validators and GitHub E2E compile-only **all exit 0**, with detached worktree `## HEAD (no branch)` clean after all gates. Preserve the unrelated primary workspace `tests/v4/github-transport.test.ts` WIP. Never commit token/passphrase, no merge/release.

- **2026-10-17 two REAL isolated Obsidian vaults encrypted restore — PASS:** Maintainer-authorized disposable GitHub target `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform`, numeric ID `1284153873`; code commit `74fdaaea6c5c3cc7dea56018eec8750ffe3fc8d5` pushed and tested on detached clean Windows checkout. Added guarded `--mode=encrypted --verify-peer` mode and `scripts/obsidian-live-ui-peer.mjs` to start a **second independent Obsidian 1.14.4 process/profile and empty vault**, verify its exact synthetic filesystem path *before* credentials, use the same ephemeral random passphrase, run encrypted Force Pull within that blank vault, then read a recovered `UI-smoke.md` using actual Obsidian `app.vault.read` and assert the **complete exact plaintext**, open the note in the visible editor and capture a real PNG. **Native UI test exit 0:** `peerRestored=true`, `remoteEncryptionVerified=true`, `remoteHeadChanged=true`, `uiExceptions=0`, `cleanup=absent-verified`. The GitHub HEAD was proved **unchanged after peer Pull**; an *independent* GitHub API check confirmed exact branch `obsidian-sync-e2e/local-74fdaaea6c5c-3f7887f976e5aac1` absent after cleanup, repo ID `1284153873` and default `main` unchanged. Separate Windows check found no test Obsidian processes and no temporary run folder. The peer screenshot was opened visually; copy committed under `docs/engineering/ui-real-screenshots-2026-10-17/14-live-encrypted-second-vault-restored.png`. Report: `docs/engineering/native-encrypted-cross-vault-restore-2026-10-17.md`.
- **Exact clean-SHA gates:** frozen dependencies already installed, production Build, focused native UI/peer/encryption/cleanup tests **12/12**, Fast Tests, Repeat **10/10**, Recovery, Resource, Feasibility, Metadata/Package validators, GitHub E2E compile-only all exit 0. Detached checkout post-test `git status --short --branch` exactly `## HEAD (no branch)`. Unrelated primary `tests/v4/github-transport.test.ts` WIP untouched. This closes **desktop second-vault encrypted pull/decrypt acceptance**, *not* real separate physical device, whole Settings form flow, keyboard/screen-reader Force confirmation, physical Android/iOS, CI/master/release gate. PR #8 stays Draft, never merge/release without maintainer authorization.

### 2026-10-17 remote metadata byte ceilings and authorized live-GitHub incident

- **Remote metadata hardening:** added `src/lib/v4/metadata-bounds.ts` with fail-closed JSON limits: config 64 KiB, head 256 KiB, shard 16 MiB, journal page 32 MiB. Checks run before parsing, before/after decrypt for encrypted objects, and before publishing writer-produced metadata; encrypted publication-journal authentication is also bounded. Five focused oversize-but-well-formed JSON cases first failed due to absent guard, then passed 5/5; positive decodes preserved. Obsidian `requestUrl` still buffers HTTP before these caps and is **not** fixed by this patch.
- **Explicit authorized LIVE GitHub test:** used ignored `.env.github-e2e` as provided and **process-only** overrides of missing `GITHUB_E2E_EXPECTED_REPO_ID=1284153873`, source ID `1282135059`, and safe unique branch; never edited/read out the token. Target `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform`, pinned numeric ID `1284153873`, default `main`. Full suite on previous code tip `30a0d378010effb55018401bfeefee85399539f1` **FAILED exit 1** in encrypted `two-device-delete-recreate-identity-break`, because stale device B received `Missing V4 remote object` for a recreated opaque object; two of three live test files passed and preceding plaintext/encrypted scenarios passed. Test after-hook verified branch cleanup. This is an **open high-severity live release gate** until root cause is identified or qualified, **not** a successful all-green E2E.
- **Real-GitHub incident narrowing:** live scenario now checks exact published SHA's tree membership and immutable object read after recreation before stale device B catches up; on failure logs safe boolean-only diagnostics. Added named live scenario and deterministic encrypted two-device delete/recreate/catch-up test, which passed locally. Named live scenario passed in separate runs `...-repro1` and `...-repro2`; an independent post-test lookup briefly suffered a network error. Subsequent authenticated read-only retries PROVED target ID `1284153873`, default branch `main` still present, and all three disposable branches `...-oct17-production`, `...-repro1`, `...-repro2` **absent**. Passing targeted reruns do not erase the original failure; no speculative writer modification.
- **Local checks** after new metadata guard: `corepack pnpm build`, `test:fast`, `test:repeat` 10/10, `test:recovery`, `test:resource`, `test:feasibility`, `validate:metadata`, `validate:package`, `test:github-e2e:compile` all exit 0; newly added two-device regression passed focused `--filter=sync-session.test.ts`. Repeat with all files at exact pushed SHA before release claims. Evidence: `docs/engineering/live-github-e2e-metadata-bounds-2026-10-17.md`.
- **Clean exact-SHA verification:** code commit `569e69dc1c50941bbde1f2dacae5d552faac8626` pushed to the audit branch. Separate detached `.tmp/metadata-bounds-clean-20261017` completed frozen install, build, Fast, Repeat 10/10, Recovery, Resource, Feasibility, metadata/package validation, E2E compile-only and real **Obsidian Desktop visual smoke** (57/57 checks, 14 screenshots, 0 observed UI JS errors), all exit 0. Post-test Git status exactly `## HEAD (no branch)`; non-credentialed UI had the standing 175px Settings popout warning. **Actions API returned 0 hosted runs** for this commit, so hosted CI evidence still open. A fresh complete live E2E targeting a unique disposable branch at this exact SHA is running separately; record its terminal outcome before treating it as proof.
- **Unrelated pre-existing WIP:** preserve and exclude `tests/v4/github-transport.test.ts` helper. Audit PR #8 stays Draft, no merge/release and no source-default-branch changes.

### 2026-10-18 fail-closed local precondition without stat capability

- **RED→GREEN data-safety fix:** `assertV4LocalTargetPrecondition` previously silently skipped path-existence, size and mtime checks if `io.stat` was undefined, allowing a pending remote Pull/new-file download to overwrite a file created while in flight. A new `tests/v4/staged-commit.test.ts` regression first **failed** for `exists:false` on a stat-less adapter (missing expected rejection), then **passed 7/7** after `src/lib/v4/local-io.ts` rejects such mutations with typed `V4LocalTargetChangedError`. Reviewed source with hash and no stat is also rejected. No conflict-policy or remote-write behavior changed.
- **Primary Windows evidence:** production build, fast, repeat **10/10**, recovery, resource, feasibility, metadata/package validators, GitHub E2E compile-only all exit 0. Native Obsidian Desktop 1.14.4 visual **111/111 checks, 22 PNGs, zero JS exceptions**, standing 375px Settings popout warning. Report `docs/engineering/local-precondition-stat-capability-2026-10-18.md`.
- **Exact pushed code SHA `ee09ceb9c5e2948ea8b1e2a85c0ddd05e0061623` independently qualified** in detached `.tmp/stat-precondition-clean-20261018`: frozen pnpm install, native Obsidian Desktop 1.14.4 UI **111/111 checks / 22 PNG / zero exceptions**, fast, repeat **10/10**, recovery, resource, feasibility, metadata/package validators, E2E compile-only all exit 0. Post-gates `git status --short --branch` exactly `## HEAD (no branch)` and SHA matched. Actual Obsidian runtime `sessionVault().stat` confirmed present. GitHub PR #8 open/Draft at exact pushed SHA; hosted workflow and live E2E not qualified. See `docs/engineering/local-precondition-stat-capability-2026-10-18.md`. Original uncommitted `tests/v4/github-transport.test.ts` user WIP excluded; no merge/release.

### 2026-10-18 second pre-write reviewed source guard after staging I/O

- **Additional RED→GREEN** after clean-source guard commit `5c81d6a`: reviewed local source may change after its first SHA-256 verification and *during/after await readStage*. The deterministic `onProgress` fixture mutates same-size/same-mtime bytes at the start of `phase: applying`. Before repair it failed `Missing expected rejection` and the late edit would be overwritten; `applyStagedWrite` now **rechecks SHA-256 immediately after staged byte read and before any local mutation**. The previously strict bounded-stat test correctly expects 12 stat calls rather than 10 (an extra pre/post-hash snapshot); retained assert unchanged in spirit.
- **Caveat**: this narrows but cannot eliminate OS write races without an atomic compare-and-write adapter. Remote publication may already have occurred before the last local guard; if an edit races at that point, preserve local edits, fail and require replan/recovery, never claim atomic cross-service rollback. No policy choices changed.
- **Exact pushed code SHA `7d163058a549eb1ee9008cd86b9eae2ac5a3d605` independently qualified**: detached `.tmp/review-post-stage-guard-clean-20261018` with frozen install, native Obsidian Desktop `test:ui:visual` **111/111 checks / 22 PNG / zero exceptions**, fast, repeat **10/10**, recovery, resource, feasibility, metadata/package validators and E2E compile-only, all exit 0. Post-test `git status --short --branch` exactly `## HEAD (no branch)` and exact SHA verified. GitHub PR #8 open/Draft/unmerged at code SHA; hosted workflow runs/statuses **none**. Documented in `docs/engineering/reviewed-local-source-change-guard-2026-10-18.md`. No credentialed GitHub live E2E on this SHA or physical mobile pass. Do not merge/release; unrelated `tests/v4/github-transport.test.ts` WIP excluded.

### 2026-10-18 reviewed conflict source-change guard (local data-loss prevention)

- **RED→GREEN:** `V4SyncSession` previously allowed a stale manual merged result to overwrite a local note changed *while Ask modal open*, even when the newer note kept the exact same size and mtime; `Use remote` had the same unsafe stat-only precondition. Added behavioral same-size/same-mtime mutation tests in `tests/v4/sync-session.test.ts`. Now affected merged/pull bindings carry their reviewed source hash; pre-apply and pre-publish guards check hash + stat and **abort without overwriting the user's edit or advancing the GitHub branch head**.
- **Recovery and bounded I/O:** optional 64-hex SHA-256 in recovery local mutation preconditions is validated without breaking older records, and checked when recovery writes. Small source checks use read+hash with pre/post stat; files >32 MiB use **bounded 4 MiB streaming hashes**, never whole-file `read()`, as asserted in `tests/v4/staged-commit.test.ts`. Missing bounded I/O fails closed. Cannot claim elimination of all OS-level compare/write races.
- **Primary qualification:** build, fast, repeat 10/10, recovery, resource, feasibility, package/metadata validation and GitHub E2E compile-only all exit 0. Actual Obsidian Desktop 1.14.4 synthetic UI smoke **111/111**, 22 PNGs, 0 JS exceptions. Report `docs/engineering/reviewed-local-source-change-guard-2026-10-18.md`. Source exact-SHA clean checkout/push to follow; no real GitHub E2E or physical mobile proof yet.
- **Safety:** no user-directed conflict/delete semantics changed; fail closed on stale decisions. PR #8 Draft, master and release untouched; do not stage existing user WIP `tests/v4/github-transport.test.ts`.

### 2026-10-18 compact whole-hunk selections for scalable Conflict Review

- **RED→GREEN performance/safety fix:** large paged Conflict Review's Keep all / Omit all hunk shortcuts previously materialized **one decision Map entry per line** even while the DOM was bounded at 96 rows. Now whole-hunk decisions are compact defaults (`Map<sectionIndex,V4ReviewChoice>`) and only individually changed Keep/Omit lines are overrides. Selecting a new shortcut resets prior overrides for that hunk, preserving original semantics. All-lines-decided gating, keyboard-visible `aria-pressed`, editable merged result and explicit Reset continue to work across pages. No forced conflict winner or change to sync protocol.
- **Coverage:** RED test of **100,000 changed lines per side** now passes with only one override and exact resulting bytes; paged 900-line UI regression exercises shortcut→single-line override→replacement shortcut across pages; real Obsidian Desktop 1.14.4 synthetic 12,000-line-per-side native UI result **111/111 checks, 22 screenshots, 0 JS exceptions** (observed shortcut response 17ms; 96 DOM lines). Primary build, fast, repeat **10/10**, recovery, resource, feasibility, metadata/package validators, GitHub E2E compile-only all exit 0.
- **Exact pushed-SHA independently qualified:** code `61a27a1a1df9b87fbc4bea74ea9f1bc1d5f55b17`, frozen install on detached `.tmp/compact-conflict-clean-20261018`, native Obsidian 1.14.4 **111/111 checks, 22 PNGs, 0 JS exceptions**, observed 12ms hunk action for 12k local+12k remote rows and 96 mounted line rows. Full clean fast, repeat **10/10**, recovery, resource, feasibility, package/metadata validators, GitHub E2E compile-only all exit 0; post-test exact SHA and `## HEAD (no branch)` verified. Evidence `docs/engineering/scalable-conflict-hunk-shortcuts-2026-10-18.md`. No credentialed full GitHub E2E or physical mobile claimed. Draft PR #8, no merge/release; original uncommitted `tests/v4/github-transport.test.ts` WIP excluded.

### 2026-10-18 clean diagnostic SHA qualification and fast-suite prerequisite

- **Exact pushed diagnostic SHA `4e00e25c823859f01f333059d1e4e596191fd08a`** qualified from independent detached `.tmp/controlled-race-clean-20261018`, frozen pnpm install exit 0. First `pnpm test:fast` before build failed **1/645** solely because fresh checkout lacked `main.js` (`ENOENT`, test `production CommonJS plugin prefers require ...`); after `pnpm build` exit 0, **Fast 645/645 passed**, E2E compile-only exit 0, native Obsidian Desktop **110/110 UI checks / 22 screenshots / zero JS exceptions**. Detached worktree stayed `## HEAD (no branch)` with exact SHA. Build-before-fast is a qualification prerequisite, not a sync regression; do not hide the initial first-run failure.
- Credentialed focused GitHub controlled race passed on a pre-final-redaction compiled test snapshot with verified repository ID `1284153873`, preserved `main`, independent cleanup of temporary branch. This is **not a credentialed full E2E pass at the pushed SHA**. Full-suite race hook nonfire remains unexplained. Report `docs/engineering/controlled-race-e2e-diagnostics-2026-10-18.md`. PR #8 Draft, unrelated `tests/v4/github-transport.test.ts` WIP untouched.

### 2026-10-18 dense-line review memory guard and controlled live-race diagnosis

- **Code pushed `0be3db782eb7df65a27822d8c499b9b6789d6806`**: `canPrepareV4ConflictReviewPair` bounds estimated memory for millions of short/empty lines BEFORE splitting; 96 MiB estimated working set accounts for text/line slots, without reviving old 600-line cutoff. Dense 1.1-million-newline fixture falls back to explicit whole-file conflict decisions and cancel no-op, while normal 100k-line text remains reviewable. Primary fast/repeat 10/10/recovery/resource/feasibility/meta/package/E2E compile and native Obsidian **110/110**, 22 PNGs, zero exceptions all passed.
- **Exact pushed-SHA independent verification**: new detached `.tmp/scalable-dense-clean-20261018` frozen install, native Desktop 1.14.4 **110/110 checks**, 22 screenshots, 0 exceptions; fast/repeat **10/10**/recovery/resource/feasibility/metadata/package/E2E compile all exit 0; `git status` exactly `## HEAD (no branch)`, SHA unchanged. User pre-existing `tests/v4/github-transport.test.ts` WIP excluded.
- **IMPORTANT full live E2E log clarified:** prior approximately 13-minute run at clean SHA `42924dad152f6b60bfc90ef7767efb27146b38c0` **exit 1** failed in `controlled-external-branch-head-race (plaintext)`: pre-PATCH interference hook did not fire. In that run, encrypted delete/recreate (both standalone and full-suite inner scenario) PASSED. The original hook-first assertion obscured the underlying pre-PATCH failure. Added an independently selectable named controlled-race E2E and safe hook-failure diagnostic (error class + race classification, no token/header). Focused real-GitHub named scenario **PASSED 1/1** (~45s); externally advanced head was not overwritten, race classified, replan and peer restored. Pinned target ID `1284153873`, source ID `1282135059`; main intact, branch `obsidian-sync-e2e/local-0be3db7-controlled-race` absent verified via independent read-only retry after a transient network lookup error. This is not evidence that full E2E flake is resolved.
- See `docs/engineering/controlled-race-e2e-diagnostics-2026-10-18.md` and `docs/engineering/scalable-conflict-review-2026-10-17.md`. Hosted CI, full live E2E repeatability, actual mobile and external review still unverified. Draft PR #8, no merge/release. Preserve unrelated WIP.

### 2026-10-18 pathological line-density budget for scalable conflict review

- Production audit found **raw 16 MiB text cap is not enough** to bound memory: 1.1 million newline-delimited empty lines create huge string arrays even with paged DOM. Added `canPrepareV4ConflictReviewPair` before any `split("\\n")` with estimated **96 MiB total review working-set budget** (UTF-16 bytes + conservatively 64 bytes per line slot); when exceeded, the existing whole-file conflict controls remain available with explicit feedback and Cancel no-op. This is a resource-estimate limit, **not** a new fixed 600-line cap; normal 100k-line text remains reviewable.
- RED→GREEN unit tests and UI stub check dense/normal inputs and fallbacks, native Obsidian Desktop test checks 1.1m-newline synthetic input shows no line rows or editor, retains whole-file actions, and Cancel closes safely. Primary workstation `test:fast`, repeat 10/10, recovery, resource, feasibility, metadata/package validators, E2E compile exit 0; Obsidian native visual **110/110 checks, 22 PNGs, zero JS exceptions**. See `docs/engineering/scalable-conflict-review-2026-10-17.md`.
- Stage/commit/push only review engine, UI, harness, tests and these docs. Preserve unrelated uncommitted `tests/v4/github-transport.test.ts`; PR #8 remains Draft and no merge/release or physical mobile claim. Exact SHA clean checkout pending.

### 2026-10-17 fix cold-start native UI test readiness race

- Clean checkout at previously pushed `0d8b3b9132eede2e68c724bbbd4d577586dfd517` **failed first native UI run**, but the independently read `.tmp/scalable-conflict-clean-20261017/.tmp/ui-visual-smoke/runs/1792246707478-22364/screenshots/report.json` disclosed a precise failure: the `12k-line conflict uses a bounded page` check found `elapsed=877ms, visible=false` after its old **fixed 240ms delay**. No runtime exceptions were reported. An actual later rerun on that same source SHA passed **108/108** and **22 screenshots**, confirming a test readiness race, not an established runtime crash. The initial failed run is not reclassified as passing.
- Corrected `scripts/run-ui-screenshots.mjs` to poll **actual modal readiness** every 80ms for no more than 12s, then assert the same 96-row bound, page identity and Cancel/no-write requirements; no production engine or conflict semantics changed. Corrected primary-native test exited 0, **108/108 checks, 22 screenshots, zero exceptions**. Documentation now records the exact failure and correction in `docs/engineering/scalable-conflict-review-2026-10-17.md`.
- **Completed clean qualification of corrected SHA `460d4a6f5b1163453746f9637ba0d084600c270a`:** newly detached `.tmp/scalable-conflict-readiness-clean-20261017`, frozen install exit 0, **native Obsidian UI repeated twice, 108/108 checks each, 22 screenshots each, 0 JS exceptions**, fast, repeat **10/10**, recovery, resource, feasibility, metadata/package validation, GitHub E2E compile all exit 0. Detached worktree remained `## HEAD (no branch)` at exact SHA. The first earlier failing fixed-240ms runner test remains explicitly documented as a failure, not silently erased. Report `docs/engineering/scalable-conflict-review-2026-10-17.md`. User's unrelated unstaged `tests/v4/github-transport.test.ts` WIP excluded. PR #8 stays Draft; no hosted CI, live GitHub E2E, real mobile, or release claim.

### 2026-10-17 scalable conflict review replaces old arbitrary line limits

- **Maintainer authorized direct redesign**, not retention of the previous 256 KiB, 600 lines/side, 180,000-cell global LCS cap and 512 KiB output cap. New `src/lib/v4/conflict-review.ts`: patience unique-line anchors + LIS with only small local LCS-gap matrices, cooperative generator-scheduled computation for large text with abort checks, no fixed line-count cutoff. Supports up to **16 MiB per UTF-8 side** and **32 MiB merged output** under explicit Obsidian process memory budgets; binary/too-large content still retains whole-file fallback. The automatic three-way merge's separate 2 MiB limit remains unchanged.
- **Bounded UI:** `src/lib/v4/runtime.ts` pages large conflicts to one hunk and 48 lines per side at a time; controls per page <=96, decisions keyed to original sections and retained across navigation, whole-hunk choices still operate across all pages. Common context shown as bounded excerpts. Custom merged text, reset, Apply gating, abort and cancellation retained.
- **Tests:** 20k shared line anchors with two separated edits, 30k unrelated lines/side, 250k shared lines without spread overflow, 120 random exact roundtrips, async-vs-sync result parity/abort, large 900-line stub paging, >32MiB edited-result protection, real Obsidian Desktop synthetic 12k lines per side; screenshots and exact results in `docs/engineering/scalable-conflict-review-2026-10-17.md`.
- **Exact pushed code-SHA acceptance:** `0d8b3b9132eede2e68c724bbbd4d577586dfd517`, independent detached `.tmp/scalable-conflict-clean-20261017` frozen-install worktree. One initial native UI process failed with truncated evidence and is not counted as passing; captured rerun exited 0 and `report.json` independently showed **108/108**, 22 screenshots, 0 exceptions. Fast, repeat **10/10**, recovery, resource, feasibility, metadata/package validators and E2E compile-only all exited 0; clean worktree exactly `## HEAD (no branch)` at this SHA. Screenshot 37 fetched directly from pushed GitHub and visually inspected: page 2/250, Keep/Omit, sticky action buttons. No live credentialed GitHub E2E at this SHA; hosted CI/physical mobile/independent review and old intermittent encrypted delete/recreate remain blockers. PR #8 stays Draft and unrelated `tests/v4/github-transport.test.ts` WIP excluded. Report: `docs/engineering/scalable-conflict-review-2026-10-17.md`.

### 2026-10-17 per-line conflict merge corrected to match maintainer UI intent

- **User correction:** conflict review must support **independent Keep/Omit per individual Local/Remote line within the same change hunk**, not only old hunk-level Accept local/remote/both/discard. Added genuinely independent line decisions in `src/lib/v4/conflict-review.ts` with no implicit default; Apply disabled until every differing line is reviewed. Hunk-level shortcuts remain; a `textarea` permits arbitrarily editing/reordering final merge result before Apply. Further line selections **preserve** manual edits until explicit Reset. Cancel/abort/close remain no-op; existing staged publication/remote revision protections retained.
- **Bounded rendering:** 256 KiB per text side, at most 600 lines per side, <=180,000 diff matrix cells; larger, binary, complex content stays with whole-file options. Manually edited output max 512 KiB UTF-8. Desktop two-column and compact 390px desktop emulation.
- **Tests:** new unit model mixed individual lines from one hunk (including omitted lines/Unicode/newline), DOM test all-lines-required, manual editing persistence/reset, oversized output, many-line safe fallback. Real Obsidian Desktop visual test **102/102 assertions, 21 screenshot PNGs, zero JS exceptions**; synthetic editor output demonstrates mixed Local Rate 100 and Remote Owner in one hunk. Report `docs/engineering/conflict-line-merge-2026-10-17.md` and screenshots 31/32/33 in `docs/engineering/ui-real-screenshots-2026-10-17/`.
- **Exact code SHA clean acceptance:** pushed `856302f298a4812f5f519b0dc082d477a3a7c723` (feature `5fb98a1` plus sticky footer). Detached `.tmp/conflict-line-clean-20261017` with frozen pnpm install passed native Obsidian Desktop **102/102**, 21 PNG screenshots, zero JS exceptions, build, fast, repeat **10/10**, recovery, resource, feasibility, metadata/package validators and E2E compile-only, all exit 0. Git clean-checkout post-test status `## HEAD (no branch)` with exact SHA verified. Screenshots 35/36 fetched from pushed GitHub commit and visually examined, confirming visible Apply/Cancel even at emulated 390px. Full credentialed GitHub E2E **not rerun at this SHA**; earlier flaky encrypted delete/recreate full suite, hosted CI, physical Android/iOS and independent review remain blockers. No merge/release PR #8. User WIP `tests/v4/github-transport.test.ts` excluded. No Files sidebar Remove / bulk Delete (N) UI. See `docs/engineering/conflict-line-merge-2026-10-17.md`.

### 2026-10-17 decision revised: exclude Remove and bulk Delete from the Files sidebar

- **Final maintainer decision:** do **not** add `Remove` per-file buttons, the `Delete (N)` bulk button, or a replacement destination chooser. The earlier "choose GitHub or Vault" decision and A/B persistence question are **superseded, closed, and must not be re-asked**. The Files sidebar remains a read-only status/tree/filter view; ordinary V4 Sync and its existing conflict/deletion handling remain intact. This excludes the *extra sidebar controls*, **not** legitimate file deletions resulting from normal sync.
- **Implementation verified:** `src/views/sync-center.ts` never introduced these destructive buttons; no runtime mutation is necessary. Keep the `tests/v4/planner.test.ts` deletion-propagation regression tests, because one-sided deletes may be propagated to the other side or a file may be restored depending on the baseline. It is **not correct** to promise a file will *always* return.
- **Decision record:** `docs/engineering/files-sidebar-no-delete-decision-2026-10-17.md`. Delete the older selective-delete *proposal* from the active source tree; it remains historically available via Git. PR #8 stays Draft. Preserve `tests/v4/github-transport.test.ts` unrelated WIP.

### 2026-10-17 reviewed-remote conflict publication safety

- **RED→GREEN:** accepting remote in every hunk returned `mergedBytes` identical to pinned remote, but the Ask path still scheduled a **new GitHub Push**. An actual deterministic two-device fixture measured `pushedFiles=1` instead of `0`. Now, *only* if reviewed bytes match the verified remote SHA-256 hash + size and path, it applies the verified **Pull** flow, preserving the exact GitHub ref and replacing local bytes. Mixed content and rename decisions still use the original staged Push. This changes no automatic conflict/delete policy and preserves all-decision-before-write transactional behavior.
- **Exact SHA qualification:** source `5332a1d045792dcf82bab669daa8ca23e53ee715` pushed and independently verified in detached `.tmp/reviewed-remote-clean-20261017`: frozen install, production build, fast, repeat **10/10**, recovery, resource, feasibility, metadata/package validators, E2E compile-only and native Obsidian Desktop **101/101 / 21 screenshots / 0 JS exceptions**, all exit 0; post-gates status `## HEAD (no branch)`. New credentialed **two-device reviewed-remote scenario PASSED on actual GitHub for plaintext and encrypted**: remote head unchanged, local restored. Repository ID `1284153873`, default `main` intact and each disposable branch independently checked absent; `.env.github-e2e` not modified. **BUT the complete live E2E suite FAILED (exit 1)** in the older named encrypted delete/recreate case. Focused same-case reruns then PASSED **4/4**, including three rounds recreating the same disposable branch, without establishing the full-suite failure's root cause. Raw full-suite final assertion output was truncated by the initial task capture, so do not speculate that writer/Contents 404 is confirmed. This remains a **release blocker** requiring complete full-suite log capture and deterministic reproduction. Hosted Actions lookup yielded 0 PR workflow runs/commit statuses for the code SHA.
- **Evidence:** `docs/engineering/reviewed-remote-no-publication-2026-10-17.md`. No files staged from the user's unrelated `tests/v4/github-transport.test.ts` WIP. PR #8 remains Draft; per-file Remove/Delete target semantics require maintainer decision.

### 2026-10-17 remote rename UX lineage follow-up

- **RED→GREEN**: Files tab formerly labeled one V4 file renamed on GitHub as `Deleted remotely` plus unrelated `Remote only`. The read-only overview now connects old/new paths using **unique shared fileId across last-synced baseline and pinned remote**, and displays `Changed` with `Moved on GitHub` / `Renamed on GitHub` plus reciprocal paths. Missing, duplicated or ambiguous IDs do **not** produce a false rename claim; normal sync and conflict policy are unchanged.
- **Verification:** `file-overview.test.ts` positive/negative lineage, `sidebar-conflict-ui.test.ts` label and detail, actual native Obsidian 1.14.4 UI runner **101/101 checks, 21 screenshots, 0 observed exceptions**, screenshot `docs/engineering/ui-real-screenshots-2026-10-17/30-files-remote-rename.png`. Primary Windows build, fast, repeat **10/10**, recovery, resource, feasibility, metadata/package validation and E2E compile-only all exit 0.
- **Remaining risks:** no live-GitHub credentialed E2E on this change, true 3-way rename conflict policy remains separate maintainer decision, physical mobile not verified, hosted CI not confirmed. Do not release/merge Draft PR #8. Original unstaged `tests/v4/github-transport.test.ts` remains excluded.
- Evidence: `docs/engineering/file-status-and-conflict-review-2026-10-17.md`. **Exact pushed code SHA `dcc3fc8b71155681d7814603a5885f8cee068e85` VERIFIED** from independent detached `.tmp/remote-rename-clean-20261017`: frozen install, native Obsidian UI 101/101 / 21 PNGs / 0 exceptions, fast, repeat 10/10, recovery, resource, feasibility, metadata/package validators and GitHub E2E compile-only all exit 0; post-gates worktree exactly `## HEAD (no branch)`. Actual PNG read back from GitHub and visually inspected. Not live GitHub E2E or hosted CI.

### 2026-10-17 production follow-up: tracked deletions and scalable Files tree

- **RED→GREEN data-safety UI fix:** previously tracked file deleted on just one side must not be shown as a new `Local only` / `Remote` file. The Files model now emits `Changed` with `Deleted locally` / `Deleted remotely` details and warnings that sync **may propagate deletion**. Truly one-sided untracked files keep Local only / Remote badges. This is a read-only warning; no destructive per-file commands were added.
- **Wide-folder algorithm:** `treeV4FileOverview()` now indexes nodes with `Map` instead of doing quadratic sibling scans; iterative tree sorting instead of recursive traversal, regression fixture with 12,000 siblings.
- **Native Obsidian Desktop 1.14.4:** synthetic tracked-deletion test now checks Changed count 4, exact warning texts for both directions, filters, view rendering, and Cancel for conflicts. `pnpm test:ui:visual` **100/100 checks, 21 screenshots, 0 JS exceptions**. Screenshot `docs/engineering/ui-real-screenshots-2026-10-17/29-files-tracked-deletion-warning.png`. Same 375px Settings popout warning. No real GitHub writes.
- **Prior commit exact-SHA validation:** detached clean worktree at `42f20098acc4380ff5967c5c4cd2f4f9b2fd0371` passed native 99/99, 21 screenshots, zero JS exceptions, and remained `## HEAD (no branch)` after the test. **Exact clean follow-up SHA `3672abc04b6e0825f316b068f83f12f48bbc1be0` VERIFIED** in detached `.tmp/file-status-deletions-clean-20261017` via frozen pnpm install, production build, native Obsidian UI **100/100**, 21 screenshots, 0 exceptions; fast, repeat **10/10**, recovery, resource, metadata/package validators and GitHub E2E compile all exit 0. Feasibility exited 1 once with truncated initial logs, then **passed twice** (138/138 in fully captured rerun); transient root cause not confirmed. Worktree remains `## HEAD (no branch)`, WIP excluded. Independent hosted CI/provenance, physical mobile and real credentialed E2E still outstanding. Follow-up described in `docs/engineering/file-status-and-conflict-review-2026-10-17.md`.
- **Do not stage unrelated WIP:** `tests/v4/github-transport.test.ts` existing user changes remain outside this work. Draft PR #8 remains Draft; hosted CI/physical mobile and other production gates unchanged.

### 2026-10-17 Files sidebar and per-hunk conflict review — original reference-inspired implementation

- **User-supplied UI reference:** firstsun-dev/git-files-sync (MIT) file-status sidebar; silvanocerza/github-gitless-sync (AGPL-3.0) two-pane conflict UX. This project uses only screenshot ideas and independently authored code; no AGPL source imported/copied. See `docs/engineering/file-status-and-conflict-review-2026-10-17.md`.
- **New Files Sync Center tab** becomes initial tab when a GitHub client is configured (unconfigured remains Commit history). Uses actual immutable pinned GitHub ref with validated V4 config/head/index, scope predicate and settings-generation guard. All/Changed/Local only/Remote/Synced count pills, path search, Tree/flat mode, folder toggles, file detail and Refresh. Read-only; no unsupported per-file Push/Pull/Delete buttons; existing normal Sync remains. Synced classification uses last-sync metadata stat+version, not full byte/hash comparison. UI caps rendered rows at 400 and offers filter narrowing. Synthetic native screenshot evidence and pure/runtime tests cover it.
- **New manual conflict review** in existing Ask policy: native desktop modal shows side-by-side local/remote text, common context and line hunks; per-hunk Accept local/remote/both/discard, merged preview, disabled Apply until all decisions; compact 390px emulation stacks panes. Non-UTF8/oversized/binary keep conservative whole-file controls; 256 KiB per input, bounded matrix/line counts; small packed remote groups supported, large pack/chunked fallback. Integrates existing staged/recovery/publish pipeline; Abort/Cancel are no-ops. `sync-session.test.ts` confirms verified remote bytes and reviewed merged bytes on a simulated real sync.
- **Native Obsidian Desktop 1.14.4** `corepack pnpm test:ui:visual` **99/99 checks, 21 screenshots, 0 observed JS exceptions** in isolated synthetic vault, with screenshots `docs/engineering/ui-real-screenshots-2026-10-17/24-...png` through `28-...png`. Uses synthetic status snapshot and modal with no GitHub token/remote writes; 375px Settings 175px width warning remains. Unit tests for overview, exact-ref generation guards, diff engine, DOM controls, and integration passed.
- **Primary workspace gates** `pnpm build`, `test:fast` (after updating source-coupled askConflict signature test), `test:repeat` **10/10**, `test:recovery`, `test:resource`, `test:feasibility`, `validate:metadata`, `validate:package`, `test:github-e2e:compile` all exit 0. Commit, push, independent clean-code SHA check and separate docs receipt should follow. The pre-existing `tests/v4/github-transport.test.ts` remains **uncommitted**.
- **Remaining work:** native Android/iOS devices, live GitHub E2E specifically exercising actual Ask/selection on disposable repository, full 3-way ancestor merge UX, selective file actions with scoped safety contracts, screenshot manual inspection, hosted CI evidence, intermittent encrypted recreate root cause, Draft PR #8 independent approval.

### 2026-10-17 real native Settings Secret Storage rotation and cleanup

- **Actual Obsidian Desktop 1.14.4 sensitive-settings flow:** extended `scripts/run-ui-screenshots.mjs` to enter an invalid **synthetic** token through the rendered password input; enable Encrypted sync from the rendered toggle; enter an invalid synthetic passphrase through its revealed password input; click actual Save and verify `app.secretStorage.getSecret()` values and distinct IDs, while persisted `loadData().settings` omits both secrets. Repeat with rotated values through the form and assert superseded slots empty; then clear both fields, disable encryption, Save and assert active + old Secret Storage slots empty. Owner/repo stay empty throughout, so no GitHub client or remote request is initiated. The test does not access `.env.github-e2e`, and no real secret is displayed or logged.
- **Real native suite PASS:** 79/79 checks, 16 actual PNGs, no observed JS exceptions; full `pnpm test:ui:visual` exit 0. First run reached the new secret cleanup assertions but flagged a preexisting screenshot target outside the viewport after passphrase editing; fixed the screenshot setup by scrolling the dirty banner into view without relaxing assertion. Standing 375px desktop Settings 175px plugin-content-width warning remains, no Android/iOS claim. See `docs/engineering/native-settings-form-acceptance-2026-10-17.md`.
- **Exact pushed source SHA clean VERIFIED:** source commit `c9c9289dac2b48280cbe18d840f6d9ef45e436ed`; independent detached `.tmp/native-secret-clean-20261017` with frozen install, real native `test:ui:visual` **79/79**, 16 screenshots, 0 JS exceptions, Fast, Repeat **10/10**, Recovery, Resource, Feasibility, metadata/package validators and GitHub E2E compile-only **all exit 0**. Post-test `git status --short --branch` exactly `## HEAD (no branch)`. The only primary workspace WIP stays excluded. No credentialed remote GitHub E2E on this exact commit: this change added test coverage and docs only.
- **Outstanding qualification:** actual valid credential entered through form -> hosted disposable GitHub branch sync was not performed here; source code and secret store APIs are tested with fake values only. Earlier exact-SHA real GitHub E2E 4/4 remains separate evidence; first intermittent encrypted recreate failure's cause is still unknown. Hosted CI and provenance, physical mobile and independent review are still release gates. PR #8 stays Draft, do not merge/release without approval; exclude unrelated existing `tests/v4/github-transport.test.ts` WIP.

### 2026-10-17 real Obsidian Settings form acceptance

- **New native UI workflow covered:** `scripts/run-ui-screenshots.mjs` now uses actual visible Obsidian Settings text inputs (not direct Settings draft assignment) to enter an invalid branch, click real Save, check failure and dirty banner, enter synthetic valid owner/repo/branch, click Save, check plugin settings **and** `loadData()` durability and no GitHub client/token, then clear and Save to restore an unconfigured isolated vault. CDP dispatches input/change in the Settings popout's **own Electron JS realm**; first RED runs surfaced cross-realm `instanceof` failure in the harness and were corrected without relaxing form assertions.
- **Native Obsidian Desktop 1.14.4 PASS:** direct smoke and full `corepack pnpm test:ui:visual` exited 0; **72/72 checks**, **16 PNG screenshots**, **0 observed JS exceptions**. Two reproducible synthetic-only Settings form PNGs committed at `docs/engineering/ui-real-screenshots-2026-10-17/17-settings-real-form-edited.png` and `18-settings-real-form-saved.png`; report `docs/engineering/native-settings-form-acceptance-2026-10-17.md`.
- **Fresh-checkout harness FIXED and VERIFIED at exact SHA `54f89061e8b087dab273d506f1664344a86213ca` (pushed):** first detached run at `71fbfa0` exposed missing ignored `.tmp` before fixture `mkdtempSync`; added project-local directory setup with `lstatSync` symlink/junction rejection in `tests/v4/ui-visual-smoke-cli.test.mjs`. Four focused fixture tests passed. **Independent new detached clean checkout** `.tmp/native-settings-final-clean-20261017`: frozen install exit 0, explicit check `freshTmpMissing=true`, then full production build and **real Obsidian visual suite 72/72, 16 screenshots, 0 observed exceptions**, Fast, Repeat **10/10**, Recovery, Resource **15/15**, Feasibility, metadata and package validation and E2E **compile-only**, all exit 0. Post-suite `git status --short --branch` exactly `## HEAD (no branch)`; original primary-workspace transport-test helper still the only unstaged edit. No live GitHub or default-branch mutation occurred in this native UI acceptance.
- **Boundaries:** did not enter a real PAT/passphrase, create a GitHub client, or mutate any repository in this desktop Settings test. Physical mobile, complete credentialed Settings-to-remote sync, screen-reader, and 375px Settings content width remain open. Earlier **full credentialed E2E on source SHA `569e69dc1c50941bbde1f2dacae5d552faac8626` passed 4/4** after the prior intermittent encrypted recreate failure; its branch `obsidian-sync-e2e/local-569e69dc1c50-requalification` was independently verified **absent**, target repo ID `1284153873`, default `main` intact. Root cause of the earlier live miss is still unknown.
- **WIP excluded:** `tests/v4/github-transport.test.ts` remains unstaged. PR #8 must remain Draft without automatic merge or release.

### 2026-10-17 configured Force confirmation keyboard acceptance

- **Accessible Force Push/Pull delivered and pushed:** code, focused tests, native UI driver, generated stylesheet, screenshots and acceptance report committed as `43c9896f9c8b05416317d3b6473ec7d89a64c7d6` to `audit/2026-09-26-production-hardening` (PR #8 remains Draft). The slider has a focus target, horizontal slider ARIA state/value/target label, Arrow key stepping, Home/End, a visible keyboard focus outline, and an explicit second Force button. The settings-generation guard and pointer confirmation remain intact.
- **RED/GREEN:** 6 focused keyboard/pointer/destructive-guard regressions first failed with missing slider semantics, then all 6 passed after the fix. Confirmed no operation on Enter/Space alone, partial keyboard progress, unlocked-but-not-confirmed state, cancel, changed-target rejection, and duplicate-click safety.
- **Actual native Obsidian Desktop 1.14.4 acceptance PASSED:** isolated synthetic vault and Electron profile, no GitHub client and no persisted credential. `pnpm test:ui:visual` used real CDP keyboard events and focused the Force slider for both modes. Nine Right presses kept `aria-valuenow=90` and the action hidden; ten set 100 and revealed the button; the test selected Cancel and never initiated Force. Real PNGs were captured and visually inspected after push: `docs/engineering/ui-real-screenshots-2026-10-17/15-force-push-keyboard-unlocked.png` and `16-force-pull-keyboard-unlocked.png`. Native runner **57/57 checks, 14 screenshots, 0 observed JS exceptions**, one standing warning that Obsidian desktop Settings popout leaves only 175 px plugin content at a 375 px emulated window. No physical mobile or human screen-reader claim.
- **Clean exact-SHA verification:** independent detached `.tmp/force-keyboard-clean-20261017` at `43c9896f9c8b05416317d3b6473ec7d89a64c7d6` completed frozen pnpm install, production Build, Fast, Repeat **10/10**, Recovery, Resource, Feasibility, metadata and package validation, GitHub E2E **compile-only**, and the actual Obsidian visual suite, all **exit 0**. After tests, `git status --short --branch` was exactly `## HEAD (no branch)`. No credentialed remote test, merge, release or default-branch mutation occurred during this acceptance.
- **Separate WIP preserved:** the unrelated pre-existing 11-line `tests/v4/github-transport.test.ts` SHA helper remains unstaged and is intentionally not included in the pushed feature. It needs its own RED/usage evidence before a separate commit.
- **Open gates:** real screen-reader and physical mobile accessibility, full Settings UI entry, residual security/resource audit, independent PR review, hosted CI, and exact-master release qualification. The active PR must remain Draft until maintainer sign-off.

### TDD plan

Write RED regressions before fixes:
- `tests/v4/local-index.test.ts`: records tampered/omitted while advertised hash remains unchanged must invalidate cache.
- `tests/v4/sync-coordinator.test.ts` + settings/runtime contract test: cancel active run without disposing and remain reusable; settings save must quiesce before publishing new settings.
- `tests/v4/github-transport.test.ts`: unknown bootstrap response followed by competitor ref must surface a typed bootstrap race.
- `tests/v4/protocol-core.test.ts`: unsupported/unbounded encrypted remote config must fail before key derivation.
- `tests/v4/history-service.test.ts`: unsafe journal marker, excessive pageCount, and pageCount inconsistency must fail closed with bounded reads.
- new remote-metadata bounds regression: invalid size / excessive chunk descriptors reject before body fanout; chunk reader must not create unbounded concurrent reads.

After RED proof:
1. implement minimal root-cause fixes;
2. update this handoff with exact commits and any refined severity;
3. attempt focused verification in the AI environment;
4. if repository execution remains unavailable, provide one user-local focused gate before full acceptance;
5. open a draft audit PR only after the branch diff is coherent; do not merge without explicit user request.

## Final repository state

As of 2026-09-26 (Asia/Bangkok), the implementation/integration scope covered by PRs #1, #3, #4, #5, #6, and #7 is complete and landed on `master`.

- Repository: `crystalicez/obsidian-github-sync-multi-platform`
- Active implementation branch: none
- Open pull requests: 0
- Open issues: 0
- PR #4 merge commit: `43f96478007aded2ebde7cef5da81dfc3685c7c1`
- Post-merge closeout handoff commit before final branch cleanup: `76e7500d2bd9a2ca2e3d7db4cdc8145b4bf47127`
- Exact release toolchain: Node `v24.11.0`, pnpm `9.12.3`
- GitHub Actions Stable Release remains intentionally interlocked.
- The supported stable publication authority is the accepted local exact-SHA qualification/release path.

## Final acceptance evidence

Final non-destructive release-grade acceptance is GREEN.

Focused / build:
- `github-e2e-compile-cli`: 4/4 PASS
- `release-metadata`: 9/9 PASS
- `local-qualify`: 9/9 PASS
- `local-release`: 37/37 PASS
- production build: PASS
- feasibility: 138/138 PASS

Full gates:
- fast: 419/419 PASS
- repeat fast: 10/10 complete runs, each 419/419 PASS
- recovery: 43/43 PASS
- resource: 11/11 PASS
- release metadata validation: PASS
- GitHub E2E compile-only: PASS for all 3 bundles
- CI producer input-manifest path: PASS
- package validation: PASS
- final clean-tree/head integrity: PASS

The final full-gate run was performed on accepted code/test head `c6e38c5b5057adedb445a82fb5768435d22cdb73` with Node `v24.11.0` and pnpm `9.12.3`. Later commits touching only this handoff document do not invalidate that code/test evidence.

## Landed work

### Publication race / conflict recovery

Key correctness properties now landed:
- publication-race retry is structured/evidence-based; stale-message regex classification is not used;
- conflict-copy reservation identity may survive a publication replan, but stale staged bytes do not;
- recovery generation ordering is authoritative before payload-key resolution;
- stale `replan-required` state terminalizes only after a successful fresh session and local index save;
- cancellation wins over transport/mutation errors when the operation signal is aborted;
- empty-repository/custom-branch bootstrap races replan the whole operation;
- encrypted speculative bootstrap retries derive the winner KDF before reading winner state;
- runtime publication mutation races are covered by production reconciliation tests;
- debug/error sanitization preserves an allowlisted cause chain while redacting sensitive values.

### Immutable Git read fallback

Key properties now landed:
- immutable commit-SHA Contents 404 fallback is path-directed;
- tree reads are non-recursive and descend only the exact path;
- positive exact entries may be used from truncated trees;
- absence is inferred only from complete (`truncated === false`) evidence;
- malformed/duplicate/unsupported evidence fails closed;
- executable blobs are supported;
- tree/gitlink final nodes mean file absence;
- managed symlinks are rejected;
- thrown and returned 404 forms are covered;
- no broad tree cache is retained.

### Local qualification / release and live-E2E safety

Key properties now landed:
- exact-SHA annotated qualification receipts;
- create-only stable ref ownership;
- explicit draft -> exact asset verification -> publish -> post-verify release state machine;
- deterministic dependency-free ZIP32 stored packaging;
- exact toolchain/version binding;
- canonical fetch/push origin checks;
- target repository identity pinned by numeric repository ID;
- target ID must differ from canonical/current source repository IDs;
- destructive target default branch is rejected;
- required local E2E config validates before source-repository network lookup;
- source/publication credentials are stripped from live-E2E child process boundaries;
- cleanup re-proves target identity before destructive branch operations;
- local release filesystem paths/assets reject unsafe symlink/non-regular-file states;
- ZIP entry traversal shapes are rejected;
- qualification temp refs are collision-safe and compare-deleted only when invocation-owned.

## Exact Node toolchain decision

The repository's official exact runtime was intentionally migrated from Node `v22.11.0` to Node `v24.11.0`.

- `.node-version` is the authority.
- qualification/release logic remains exact-version fail-closed;
- release/feasibility/V4 metadata tests were migrated to Node 24;
- CI/release workflows consume `.node-version` or the exact CI-produced version;
- `@types/node` was intentionally not changed during the runtime-only migration to avoid unrelated type/lockfile churn;
- final build and test evidence above proves the accepted runtime/type combination.

The earlier Windows/libuv failure under Node 24 exposed a real preflight-ordering defect: `scripts/run-github-e2e.mjs` attempted source-repository network lookup before rejecting missing required local E2E config. Commit `572a69f40a84e125375cbd9f23de9b11649a1896` fixed the ordering. The focused regression then passed on Node 24.

## Remote branch cleanup

Cleanup completed successfully on 2026-09-26.

The following already-landed/obsolete remote branches were deleted:
- `agent/harden-v4-change-causality`
- `audit-hardening-2026-08-24`
- `child-c-publication-race-conflict-recovery`
- `child-d-immutable-git-read-fallback`
- `encrypted-sync`
- `feature/local-release-qualification`
- `fix/live-github-immutable-read-fallback`
- `fix/v4-rescan-causality`
- `impl/2026-08-30-live-github-e2e-safety`
- `test/real-github-e2e-superuser`

Current remote branches are exactly:
- `master`
- `agent/conflict-audit-red`
- `agent/conflict-copy-guard-red`
- `agent/conflict-history-ui`
- `agent/conflict-prefetch-red`
- `agent/task8-audit-transport`
- `design/2026-08-30-hardening-followup`

The six non-master branches above are intentionally retained historical prototype/design/agent branches. They contain unique old work and have no merged PR proving their current tips were integrated. They are not active backlog and should not be auto-deleted without an explicit future decision.

The previously noted `tmp-ignore` branch is also absent.

## Important invariants

- Never reintroduce regex/message-based stale-ref race classification where structured publication evidence exists.
- Publication reconciliation fails closed on incomplete ancestry/evidence.
- Do not treat staged conflict-copy bytes as authoritative across a changed remote snapshot.
- WAL recovery/discard remains the physical recovery-stage cleanup authority.
- Do not terminalize recovery state before local index persistence succeeds.
- Cancellation is canonical when the operation signal is aborted.
- Bootstrap races cause whole-operation replan.
- Recovery generation ordering precedes payload-key resolution.
- Immutable Git fallback never infers absence from truncated/incomplete tree evidence.
- Do not add a broad immutable tree cache without measured need.
- Destructive live-E2E operations must remain bound to explicit target numeric identity and safety checks.
- Release/qualification remains exact-toolchain and fail-closed.

## Relevant design / plan docs

- `docs/superpowers/specs/2026-08-30-publication-race-and-conflict-recovery-design.md`
- `docs/superpowers/plans/2026-09-05-publication-race-and-conflict-recovery.md`
- `docs/superpowers/specs/2026-08-30-immutable-git-read-fallback-design.md`
- `docs/superpowers/plans/2026-09-06-immutable-git-read-fallback.md`
- `docs/superpowers/specs/2026-08-30-live-github-e2e-safety-design.md`
- `docs/superpowers/plans/2026-08-30-live-github-e2e-safety-execution-ready.md`
- `docs/superpowers/specs/2026-08-27-local-qualification-and-release-design.md`
- `docs/superpowers/plans/2026-08-27-local-qualification-and-release-v2.md`

## Next action for a resumed session

There is no active implementation PR, issue, acceptance gate, or required branch cleanup remaining for the landed scope.

For future work:
1. Start from current `master`.
2. Create a new branch for new product/feature/correctness work.
3. Preserve the invariants above.
4. Obtain fresh acceptance evidence appropriate to the new change.
5. Do not run destructive live GitHub E2E or `release:local` merely to reconfirm historical acceptance.
6. Update this handoff whenever code/tests/design/branch/verification state materially changes.

## Last updated

- 2026-10-10 (Asia/Bangkok)
- Reason: record encrypted-journal publication hardening, the additional UX/UI/resource/rare-case audit findings (110–112), regression fixes, and clean exact-source non-destructive verification; retain the 2026-09-26 landed `master` closeout only as historical context.
