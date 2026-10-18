# Comprehensive production audit — 2026-10-18

**Repository:** `crystalicez/obsidian-github-sync-multi-platform`
**Primary Windows workspace:** `E:\Coding\obsidian-github-sync-multi-platform-forked`
**Review branch:** `audit/2026-09-26-production-hardening`, **Draft PR #8**, not merged
**Audit starting HEAD:** `4015cde91cf7fa52ed5f53f050b7a06e4c156ae4`
**Decision boundary:** User asks for another detailed cross-project audit, **not authorization to release, merge, upgrade all installed clients, overwrite private notes or run destructive live GitHub tests**. Unrelated modified `tests/v4/github-transport.test.ts` is expressly excluded from all staged changes. Maximum file tests: **100,000,000 decimal bytes**.

## Verdict and evidence semantics

**Not production-ready / release must stay blocked.** The major local correctness suites are green and the actual native Windows isolated Obsidian UI test passes, but current code has unresolved *cross-version data compatibility and external-operation* gates. A green mock/Node harness does **not** establish that existing older devices can sync records written with the new writer, that GitHub responds correctly for every modern pack case, or that mobile staging is safe.

Evidence codes: **X** = actually executed in this audit; **S** = static runtime trace; **H** = previously recorded exact-SHA historical proof; **U** = unverified against current runtime/remote/device. Only mark a gate passed if process exit is 0, exact worktree/code SHA matches, and the test covers its claimed environment.

## Runtime surface inventory

| Surface | Entry → state/I/O/side-effect traced | Evidence | Major result / remaining scope |
|---|---|---|---|
| Repository startup/settings | `src/main.ts` → `src/setting.tsx` → `src/lib/v4/runtime.ts` → generation guard / persisted settings | S; X unit suite; X isolated native screenshots | Controls and persistence covered, but physical mobile Settings/keyboard handling not retested |
| Files tree/status | `src/views/sync-center.ts` → `src/lib/v4/file-overview.ts` → inspected HEAD and local-index comparison | S; X unit + native UI | Read-only Files pane; no Remove/Delete; All/Changed/Local only/Remote/Synced; Synced is metadata-based, **not a full content hash** |
| Conflict/force confirmation | `src/lib/v4/conflict-review.ts` / `conflicts.ts` → conflict dialog → guarded Apply; Force target/confirm path | S; X fast tests; X native visual | Line/hunk choices and keyboard Force unlock observed. No current full screen-reader/touch validation |
| Upload/Git publication | `sync-session.ts` → `part-write-policy.ts`/`pack-planner.ts` → `storage-codec.ts` → `github-api.ts` → candidate Git tree/commit → guarded ref | S; X fast/resource/soak; H real GitHub | New parts/pack encrypted blob <=8 MiB; partial/candidate/ref unknown outcome mitigations; semantic Git-tree response proof incomplete |
| Download/recovery | `remote-loader.ts` → authenticated head/shards → `storage-codec.ts` → `staging-store.ts` → `platform-io.ts` → local commit/recovery | S; X recovery/soak; H native 2-vault restore | Staged write safety and SHA checks covered on Windows synthetic IO; mobile >buffer ceiling fails closed |
| Encryption/secrets | `crypto.ts`, `keyring-cache.ts`, `secrets.ts`, encrypted paths and metadata AAD | S; X crypto tests; H real encrypted GitHub | AES-GCM + PBKDF2 600k default; plaintext leakage tests; retired-key lifetime remains open |
| History preview | `history-service.ts` → journal/page bound → pack-group reader → history preview UI | S; X fast/UI | Bounded V4 journal/shard metadata parsing; GitHub HTTP body already buffered before application bound |
| Request retries/rate limits | `github-api.ts` → `request-scheduler.ts` → `transport-policy.ts` and mutation classification | S; X new RED/GREEN | **New real defect found:** normal 403 permission failure with ordinary reset header was retried/cooldown as quota. Fixed in this audit; see below |
| Local platform | `platform-io.ts` → desktop fs path ancestry/symlink guards and staged rename/backup; mobile adapter capabilities | S; X recovery tests | Desktop root confinement covered; mobile bounded read/free-space/stage commit cannot be inferred from desktop capabilities |
| CI/release | `.github/workflows/*`, `scripts/local-qualify.mjs`, `local-release*.mjs`, package checks | S; X feasibility+validation; U hosted run | Stable Release workflow intentionally fails first. No hosted exact-current-SHA success verified; Draft PR still open |

## Findings — sorted by production impact

### AUD-01 — P1 / cross-version sync safety: new medium chunk format breaks older readers (CONFIRMED CONTRACT RISK; release decision required)

- **Trace:** `src/lib/v4/large-files.ts` separates `shouldWriteV4Parts` (>8 MiB) from old `shouldUseV4Parts` (>50 MiB); `src/lib/v4/storage-codec.ts` and `remote-index.ts` now accept new medium `storage:chunked` records.
- **Scenario:** Device A upgrades and publishes 16 MB encrypted file as 2 parts, while Device B remains on V4 release expecting chunked only above legacy 50 MiB. B may reject the valid new record and fail to sync. This is a **forward-compatibility** problem; current-code backward read compatibility is independently tested.
- **Impact:** Cross-device sync outage, failed restores on outdated clients. Prefer fail closed over metadata reinterpretation.
- **Action:** Require coordinated all-device upgrade **or** add explicit capability/protocol negotiation and block writing the new format until peers support it. This is a product/protocol decision; do not silently force migration.

### AUD-02 — P1 / remote response memory: Obsidian requestUrl buffers before application validation (UNVERIFIED RUN-TIME RESOURCE RISK)

- **Trace:** `src/lib/github-api.ts:130–140` awaits `requestUrl`; `response.arrayBuffer` already exists before size checks. `metadata-bounds.ts` correctly bounds V4 config/head/shard/journal **before JSON parse**, and Git raw blobs are checked against SHA, but this happens **after HTTP buffering**.
- **Scenario:** Malformed/forged or unexpectedly large GitHub body exceeds the configured transient memory budget before the application rejects it. Multi-blob or history requests could compound memory use.
- **Impact:** Obsidian freeze/OS memory pressure; mobile device risk higher. No proof of ordinary GitHub producing malicious bodies.
- **Action:** Add a transport capable of streaming/bounded response reads where supported, or enforce precondition via endpoint/blob-size metadata and absolute response cap at the actual I/O layer. Keep fail-closed cap and desktop/mobile analysis. Never claim a post-buffer size check enforces peak-memory bounds.

### AUD-03 — P1 / immutable tree semantics: successful createGitTree response not fully authenticated (UNVERIFIED SECURITY/CORRECTNESS RISK)

- **Trace:** `git-tree-writer.ts:createV4CandidateCommit` gets tree SHA returned by `GitHubClient.createGitTree`, constructs commit, then publication gates authenticate certain objects/ref. Standard tree endpoint validation checks SHA/type/path fields, not all requested base-tree-plus-edits semantics for every returned candidate.
- **Scenario:** Bad API response, upstream race, bug, or malicious gateway produces a syntactically valid but semantically incorrect tree SHA. A later checked commit might refer to unrequested content.
- **Impact:** Unexpected remote content changes, difficult rollback (no evidence this occurred in prior live runs).
- **Action:** Authenticate bounded expected tree transformation using content-addressed Git tree rules and focused tamper regressions, without naive unbounded recursive scans. A protocol review is required before changing publication assertions.

### AUD-04 — P1 / physical current-build coverage gaps (UNVERIFIED RELEASE GATE)

- **Trace:** `tests/baselines/v4/windows.json` physical 100 MB gate; `tests/github-e2e/v4-real-100mb-github-e2e.test.ts`; platformIO native staging; synthetic UI runner.
- **Known:** Historical 100,000,000-byte encrypted real GitHub round-trip passed at 8 MiB part default in disposable target; current offline Windows source→encrypted pack/parts→target hash/recovery tests pass; separate native Windows Obsidian small-file encrypted push and two-vault restore have historical real-app proof.
- **Missing:** Exact current commit-SHA credentialed live **16 MB medium chunk**, **96-file encrypted pack**, and physical native Obsidian **100 MB** push/pull/recovery/memory receipt. Android/iOS independent device smoke is not proven. Preserve permanent max test size of 100 MB.
- **Action:** On independently verified disposable repo and separately approved owned branch, repeat these live gates with cleanup assertions and no secrets in logs. Do not promote the historical result to current-SHA acceptance.

### AUD-05 — P2 / permission-denied GitHub responses misclassified as rate-limited (CONFIRMED; FIXED in audit)

- **Trace:** `github-api.ts:144–153` previously classified *any* 403 carrying `x-ratelimit-reset` as throttling; `request-scheduler.ts` then retried even when `x-ratelimit-remaining` was nonzero. GitHub documents reset header as ordinary quota telemetry, **not proof of exhausted quota**: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- **Repro (RED):** Simulated REST 403 `Resource not accessible by integration`, quota remaining=4800, reset header present. Expected **1** request; observed **3**. May induce minutes of pointless delay or misleading error messages for bad repo permission.
- **Fix (GREEN):** Require `Retry-After`, actual zero remaining, or explicit rate-limit/abuse message for 403; keep 429 retry. Under a secondary limit with remaining>0, use bounded cooldown rather than waiting for unrelated primary-reset time. Added `tests/v4/github-403-rate-classification.test.ts` (**3/3**) and transport policy assertions. No change to success codes, write retry/idempotency safeguards, or permissions.
- **Qualification:** Regression is deterministic stub evidence, not live permission-denied GitHub test.

### AUD-06 — P2 / secret memory lifetime after settings rotation (KNOWN DESIGN RISK)

- **Trace:** `src/lib/v4/keyring-cache.ts:28–63` holds invalidated/resolved keyrings in `retired` until runtime disposal; quiescing coordinator protects ongoing references.
- **Scenario:** Long-lived Obsidian session switches credentials repeatedly. Retired secrets remain in managed JS memory longer than active use, despite best-effort zeroing on final disposal.
- **Action:** Introduce lease/refcount semantics and test concurrent history/async cancellation before clearing older keyring. Do not simply zero on invalidate: in-flight reads might be corrupted. JavaScript cannot guarantee copy-free zeroization.

### AUD-07 — P2 / local JSON and recovery parser bounds (FIXED with stat preflight and parser fallback)

- **Trace:** `src/lib/v4/local-index.ts:160–184` reads whole serialized header/shard then JSON.parse; `src/lib/v4/recovery-store.ts:145–170` decodes local base64 payload and parses. Remote V4 index/journal/config/head **do** have `assertV4MetadataBytes` pre-parse bounds; these are *not* universally absent.
- **Scenario:** Corrupt, substituted or severely bloated local index/recovery file causes memory pressure before integrity checks.
- **RED/GREEN:** Oversized but valid JSON was accepted as a trusted local index, or as the newest recovery generation ahead of an intact older copy. New tests prove this with actual `loadV4LocalIndex()` and `createV4RecoveryStore().load()` calls. Both tests initially failed before code change.
- **Fix:** The local index header is bounded to 64 Ki UTF-16 code units, while shards and recovery slots are bounded to 32 Mi UTF-16 code units before `JSON.parse`. Writers reject serialized output above those caps. Invalid cache state forces a rebuild. Oversized recovery slots are treated as torn; if a previous generation is valid, the store recovers it, otherwise it raises `V4RecoveryRequiredError`.
- **Follow-up:** Real Obsidian adapters can expose `stat(path).size`. The index and recovery stores now reject oversized files from that byte count **before calling `read()`**; standalone adapters lacking `stat` retain the older post-read guard. Write limits check both UTF-16 string length and actual UTF-8 bytes so a multilingual index cannot be persisted only to fail the next size preflight. RED tests showed the earlier path read and trusted over-limit metadata; GREEN tests verify zero reads and fallback to the older valid recovery slot.
- **Limitation:** This is a stat-then-read guard, not an atomic bounded file descriptor. A concurrent file replacement between `stat` and `read` can still allocate before the post-read guard rejects it. Native Obsidian implementation and cross-device acceptance remain separate evidence gates. Tests limit individual synthetic inputs to less than 100 MB.

### AUD-08 — P2 / hosted CI, release provenance, independent review (OPEN GATE)

- **Trace:** `.github/workflows/ci.yml` runs push/PR gates; stable `release.yml` intentionally fails first; `pre-release.yml` is conditioned on manifest path or manual dispatch; `github-e2e-live.yml` requires current master/producer evidence.
- **Evidence:** GitHub connector reports PR #8 is **open, draft, not merged**. A first-page search of PR-event workflow runs for `fc414808` returned empty, but that wrapper **does not enumerate push-event runs**. Consequently hosted exact-SHA CI remains **unverified**, not definitively absent.
- **Action:** Obtain hosted CI job logs/checks for exact review head, independent approval, master promotion, then official frozen exact-master-SHA qualification/receipt. Do not enable stable release YAML or create tag/release as part of audit.

### AUD-09 — P2 / narrow native Settings popout UX (OBSERVED HOST LAYOUT WARNING)

- **Trace:** `scripts/run-ui-screenshots.mjs` creates a new isolated vault/profile; UI covers Settings, GitHub config form, Files, Commit history, force keyboard confirmation. `src/setting.tsx`, `src/views/sync-center.ts`, `src/styles.scss` source reviewed.
- **Real result:** This audit's Windows synthetic-native Obsidian run **PASSED 111 checks**, produced PNG screenshots with **zero captured JS exceptions**; one warning: desktop Settings popout with a 375 px window leaves only **175 px plugin content**. This is **not** mobile acceptance or screen-reader proof.
- **Action:** Test actual constrained desktop/mobile settings pane dimensions, form/tab order, touch targets and overflow in both dark/light and high zoom. Consider simplified responsive grouping, not a forced modal-width change without device proof.

### AUD-10 — P3 / older engineering docs and dev dependency (CLEANUP)

- Release-readiness snapshot `docs/engineering/production-release-readiness-2026-10-10.md` describes older SHA snapshots and historical open risks. Newest same-day handoff/report should be authoritative; avoid interpreting old document as current gate results.
- The project uses Node `v24.11.0` and pnpm `9.12.3` for qualification; dev-only esbuild `^0.24.2` previously flagged for tooling hygiene. No observed `serve()` usage in released plugin; upgrade lockfile with independent build/packaging verification, not by blind bump.

## Tests performed during this audit

| Gate | Observed result | Evidentiary boundary |
|---|---|---|
| `pnpm build` | **PASS**, exit 0 | Source compilation/CSS/TS |
| `pnpm test:fast` | **667/667** before new rate test; subsequent **10 × 670/670** passed after the fix | Includes original user WIP when run in primary working tree; do not call this clean SHA |
| `pnpm test:resource` | **18/18**, exit 0 (also rerun after fix) | Pack/blob planner/resources |
| `pnpm test:soak` | **6/6**, exit 0 | Legacy 48 MiB/32 MB, medium 16/32/50 MB and 100 MB file-backed offline; no >100 MB |
| `pnpm test:recovery` | **50/50**, exit 0 (also rerun after fix) | Crash/replay/staging tests |
| `pnpm test:feasibility` | **139/139**, exit 0 | Local safety/release/permissions mocks |
| `pnpm test:github-e2e:compile` | **PASS**, exit 0 | Compile-only, NOT live remote proof |
| `pnpm validate:metadata` / `validate:package` | **PASS**, exit 0 | Local package metadata only |
| GitHub permission-vs-rate RED/GREEN | **RED 3 attempts not 1; GREEN 3/3** | Newly found/fixed defect, exact SHA qualification required |
| Native isolated Obsidian UI visual | **PASSED 111 checks; 0 exceptions** | No credentials, synthetic vault; 375px popout warning |
| UI runner safety regression | **8/8**, exit 0 | Screenshot runner's crop/path/safety logic |
| Hosted CI | **NO VERIFIED RUN for review SHA** | The PR-event-only connector cannot establish status of push runs |
| Current SHA native 100 MB / live pack / Android | **NOT EXECUTED** | Explicit release blockers |

After fixing 403 classification, `pnpm test:repeat` completed **10 consecutive fast rounds of 670/670**, alongside resource and recovery. These working-tree results include the original user WIP and are **not** the final clean exact-SHA proof. Clean exact-SHA verification is recorded immediately below. Its documentation follow-up changes only audit text, not the tested production code.

## Independent exact-code-SHA post-fix qualification

**Audited code/test SHA:** `642ecaacb469e01fac10ef57e19fb41d0c0bcda9`, already pushed to `origin/audit/2026-09-26-production-hardening`. The detached Windows worktree `.tmp/full-audit-clean-20261018` was independently checked out at precisely this SHA. `git status --short --branch` after all test processes exited was exactly `## HEAD (no branch)`: **no tracked changes and no untracked source**. The pre-existing modified user file `tests/v4/github-transport.test.ts` lived only in the main worktree, not this test checkout.

Executed from this SHA with frozen Node/pnpm project lockfile install (all **exit code 0**):

| Command | Actual outcome |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm build` | PASS |
| `pnpm test:repeat` | PASS: **10 complete fast suites of 670/670 each** |
| `pnpm test:resource` | PASS: **18/18** |
| `pnpm test:soak` | PASS: **6/6**, no >100 MB fixtures |
| `pnpm test:recovery` | PASS: **50/50** |
| `pnpm test:feasibility` | PASS: **139/139** |
| `pnpm test:github-e2e:compile` | PASS: compiled three suites, **not live** |
| `pnpm validate:metadata` and `pnpm validate:package` | PASS |

This confirms the corrected 403 classification with the exact committed code, on a clean Windows checkout. **The native 111-check screenshot run used the main Windows workspace**, not this detached checkout, and the former remains one host/runtime UI observation rather than a 642ecaa exact-SHA native-app qualification. Current audit's code/test tree is qualified deterministically; outstanding external/device review gates in AUD-01–04 and AUD-08 remain blocking.

## Product behavior checked and intentional choices

- **No Files-sidebar Delete / Remove controls**: Files sidebar remains read-only by prior maintainer decision; normal Sync applies deletion/conflict semantics.
- **Changed / Local only / Remote / Synced counts**: statuses are based on inspected remote commit and local tracked metadata; detail text expressly warns that Synced is not a full hash.
- **Line-level conflict review**: per-line choices, hunk paging/keyboard, bounded text size and source snapshot guards exist. Do not silently restore old whole-file-only UX.
- **Force Pull / Push**: confirmation binds saved repo/branch/scope and keyboard/pointer intentional unlock; no automatic bypass for unsaved settings.
- **No large Android claim**: missing free-space/read/atomic staging must cause an explicit capability error, never a whole-file out-of-memory fallback.
- **Large-file test policy**: no 5 GiB fixture, command, workload, release gate or claimed device proof; **100 MB decimal max** for all active tests.

## Safe next steps (order)

1. **Block release** until older-client capability/upgrade policy and CI/device gates are decided and validated.
2. Retain and test the newly fixed 403 classification; add clean exact-SHA worktree proof and preserve WIP.
3. Obtain real GitHub multi-file pack and medium chunk receipts only in verified, explicitly authorized disposable branch; confirm deletion. Current audit deliberately performed no credentialed remote writes.
4. Native Obsidian Desktop 100 MB staged recovery and per-device Android/iOS smoke on fresh synthetic vaults. Capture memory, duration, errors and real screenshots; no private notes.
5. Review response-body buffering, createGitTree semantic authentication and retired-key ownership with threat/compatibility tests before risk signoff.
6. Obtain current-SHA hosted CI and independent PR review; keep PR #8 **Draft** and no release until approval.

**Scope honesty:** This is a cross-module, runtime-path-based audit with deterministic reproductions and one actual synthetic native Obsidian UI run. It does not claim exhaustive semantic proof for every file/line, remote service or device.
