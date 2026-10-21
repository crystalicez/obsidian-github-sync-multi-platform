# HANDOFF — NEXT SESSION

> Persistent handoff for the `obsidian-sync` project.
>
> **Mandatory workflow rule:** Every AI session that makes a material change to code, tests, design decisions, branch/PR state, verification status, or next steps MUST update this file before ending or handing work off. GitHub is the source of truth.

## 2026-10-21 Stage C2b legacy shard-hash and pack writer/read compatibility (isolated only)

- **Scope:** Continued user-approved staged integration from `e9b7baa279773e79ebd4e9fc3171e1ef23214951` in `.tmp/staged-production-6c67c8a` / `audit/2026-10-21-staged-production-integration`, no source-master push/release, no GitHub Actions, no original Zed `AGENTS.md` touch, no actual test file > **100,000,000 decimal bytes**.
- **Legacy shard hash contract proven:** `src/lib/v4/sync-session.ts` calculates `sha256(JSON.stringify(records.sort(pathId)))`, **including** local-only `dirty/deleted` fields when present. The feature candidate's `shard-hash.ts` canonicalizer strips local-only properties; for the same logical records, digests differ. New `tests/v4/staged-shard-hash-pack-compat.test.ts` proves this with a deterministic fixture and independently checks hashes against the metadata writer's bytes/records per bucket. **Do not import candidate hash algorithm or strict head-cache validation by itself**: it would make older persisted heads/unchanged shard caches appear corrupt and could block legitimate vaults. A coordinated writer+loader+cache transition with verified read compatibility and an owner decision is still needed.
- **Safe performance refactor applied:** `src/lib/v4/pack-planner.ts` now accumulates plaintext/archive/base64 scratch size as each candidate is appended, avoiding repeated whole-pack estimates on every group member. **Preserved all prior pack wire thresholds** (`64` minimum changed files, `500` entries, `32 MiB` plaintext group, `1 MiB` entry) and preserved legacy `maxPlaintextBytes`, `maxResidentBytes` and `maxTransportTransientBytes` policy. Deliberately removed candidate-only REST-safe writer hardcap from this isolated performance refactor; changing storage threshold remains a separate protocol-level stage. An independent *legacy reference planner* compares outputs for 725 deterministic mixed-size/folder files at nine bounded resource budgets. Existing encrypted packed-member rename/preview and part tests remain in Fast.
- **Validation:** `pnpm build` PASS; `pnpm test:fast` **451/451 PASS**; `pnpm test:repeat` **10/10 rounds of 451/451 PASS**; `pnpm test:recovery` **43/43**; `pnpm test:resource` **11/11**; `pnpm test:feasibility` **132/132**; `pnpm test:soak` **1/1** (100,000,000-byte virtual SHA stream, NOT encrypted push/pull); `validate:metadata`, `validate:package`, `test:github-e2e:compile` PASS. This stage did not use GitHub live writes, Actions or real vaults.
- **Still pending:** Stage C2 coordinated strict shard hash/part writer limit migration, old/new record reader compatibility and historical immutable remote verification; then Stage D durable Recovery/Conflict and Stage E strict GraphQL CAS + persistent cooldown as coupled groups. Do not claim Production Ready or silently publish this candidate to `master`.

## 2026-10-21 Stage C2a validated remote record descriptors and path topology (isolated only)

- **User directive:** "ทำต่อ" after approving staged Production Candidate integration. Continue on `.tmp/staged-production-6c67c8a`, `audit/2026-10-21-staged-production-integration` (parent commit `8cec44b801436b4bba3bfa5a1e6018f4a6b6563a`). **NEVER GitHub Actions, no source master push/release, no root Zed checkout or user `AGENTS.md` changes, no physical test file >100,000,000 decimal bytes.** The source `master` remains at `6c67c8a6d77cd03ab66fdd4b7654c5a5afd23ade` pending separate user authorization.
- **FAIL-FIRST verified portable data-safety bug:** Old `assertV4RemoteRecordSet` accepted case-fold/NFC collisions (`Notes/A.md` / `notes/a.md`, composed/decomposed Unicode) and ancestor file/folder collisions (`Dir` / `dir/file.md`), risking overwrites on cross-filesystem recovery. A new `assertV4LogicalPathSetSafe` rejects collisions **before vault mutation**, without automatic rename or data change; tests failed before the fix and passed after. Existing vaults with these paths now fail closed instead of overwriting; a remediation UX/owner decision is required before stable Release.
- **Descriptor integrity checks:** `src/lib/v4/remote-index.ts` validates runtime types for remote `pathId`, `fileId`, `plaintextSha256`, `remoteVersion`, `remotePath`, nonnegative safe integer `size` and finite `mtime`. Kept existing descriptor compatibility for prior encrypted legacy pack loose `encryptedPath`, 48 MiB chunked parts, ~9 MiB single blobs and externally synthesized `remoteVersion: "external:..."` markers. Initial strict candidate regex for `plaintextSha256` and `remoteVersion` broke legacy tests, so rolled them back to nonempty-string checks without weakening type/size fail-closed. See newly added `tests/v4/staged-remote-topology.test.ts` and `tests/v4/staged-remote-descriptors.test.ts`.
- **C2b compatibility blocker, NOT silently integrated:** Legacy `src/lib/v4/sync-session.ts` writes Shard Hashes of JSON of full records; candidate `shard-hash.ts` removes local-only fields and canonicalizes before hashing. Candidate 8 MiB REST-safe writer differs from the master-era ~50 MiB single threshold. Strict candidate remote shard hash and size validation imported on its own would potentially block old vaults. Pair writer, loader, cache hash, Pack/Parts planner, metadata read compatibility and persistent migration before enforcing. **No new Shard Hash algorithm or Pack/Part remote storage thresholds in Stage C2a.** Stages D Recovery/Conflict and E GraphQL strict CAS/cooldown still pending.
- **Local Stage C2a verification:** `pnpm build` PASS; `pnpm test:fast` **449/449** PASS after adding one 9 MiB/external-marker compatibility case; `pnpm test:recovery` **43/43**; `pnpm test:resource` **11/11**; `pnpm test:feasibility` **132/132**; `pnpm test:soak` **1/1** 100,000,000-byte *virtual* hash (NOT fully encrypted upload/download); `pnpm validate:metadata`, `pnpm validate:package`, `pnpm test:github-e2e:compile` PASS. `pnpm test:repeat` **PASS 10/10 rounds, each 449/449**, rerun after final malformed-path/null-record validation and external-version compatibility checks; Build/Fast also PASS after final source edits.
- **Reference:** `docs/engineering/production-integration-stages-2026-10-21.md` now distinguishes C2a completed from C2b coordinated remote hash/storage migration. Do not merge 531 prior feature commits wholesale; no GitHub Actions.

## 2026-10-21 Stage C1 master-derived metadata bounds (audit branch only)

- **Scope:** Continued the user-approved staged integration on isolated `.tmp/staged-production-6c67c8a`, `audit/2026-10-21-staged-production-integration`, based on `origin/master` `6c67c8a6d77cd03ab66fdd4b7654c5a5afd23ade` plus Stage A `58fd261` and Stage B `fa54a2f`. **DO NOT push master or release; NEVER use GitHub Actions.** No access to real user vaults or worktree root `AGENTS.md`, and no test file larger than **100,000,000 bytes**.
- **Stage C1 added (safe subset):** `src/lib/v4/metadata-bounds.ts` limits config 64 KiB, head 256 KiB, shard 16 MiB, journal 32 MiB; `crypto.ts` exposes the existing unchanged AES-GCM wire overhead. `remote-index.ts` checks wire bytes before parsing or decrypting, and plaintext bytes after decrypt; encoding oversized metadata fails. `history-service.ts` now enforces journal limits before decrypt/JSON parse in both plaintext and encrypted history; no journal format change. `local-index.ts` uses exact UTF-8 byte counts and optional stat preflight to bound cache header/shard reads/writes, treating invalid oversized cache as rebuild-needed rather than trusting a stale commit. `runtime.ts` connects Obsidian adapter stat when available. Tests include `staged-metadata-bounds.test.ts`, `metadata-byte-bounds-stage.test.ts`, `staged-local-index-bounds.test.ts`, `staged-journal-bounds.test.ts`.
- **Verification after Stage C1:** `pnpm build` **PASS**; `pnpm test:fast` **440/440** PASS; `pnpm test:repeat` **10/10 rounds, each 440/440 PASS**; `pnpm test:recovery` **43/43**; `pnpm test:resource` **11/11**; `pnpm test:feasibility` **132/132**; `pnpm test:soak` **1/1**, exactly 100,000,000-byte virtual SHA-256 stream (NOT encrypted push/pull); `validate:metadata`, `validate:package`, `test:github-e2e:compile` PASS. Newly added preparse/cache/history adversarial tests PASS. Source `master` unchanged.
- **Unresolved data compatibility risk / future Stage C2:** DO NOT copy the full candidate `remote-index.ts` record/topology/packs/shard-hash rules without checking their interaction with the older master reader/writer and legacy metadata. Schema/policy changes require explicit decision. C2 must handle remote record set, opaque pack/parts writer size and GitHub API mutation budgets as a coordinated change, then D Recovery+Conflict and E GraphQL strict CAS+cooldown+Runtime/UI. Detailed stage roadmap `docs/engineering/production-integration-stages-2026-10-21.md`.
- **Other permanent constraints:** preserve original Zed root checkout and untracked `AGENTS.md`; only approved remote test repo `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform` numeric ID `1284153873`, randomized absent-first branches and absence-verified cleanup. No hosted CI, no GitHub Actions, no merge/release until separately approved.

## 2026-10-21 Staged Production Candidate integration — USER APPROVED isolated only

- **User decision:** Approved selecting and testing Production Candidate groups on a fresh `master` base in an isolated worktree; explicitly **not** pushing `master` or releasing without a later decision. Use poteto-mode FULL, **NEVER GitHub Actions**, preserve user's root Zed checkout and untracked `AGENTS.md`. Development candidate `d3b1979ad2851efcc933fecd60b7332809b11a51` diverges from `master` by **531 feature-side commits and 2 master-side commits**, affecting 247 files. Never blindly merge or cherry-pick them all.
- **Integration branch:** `audit/2026-10-21-staged-production-integration` in `.tmp/staged-production-6c67c8a` created directly from exact `origin/master` `6c67c8a6d77cd03ab66fdd4b7654c5a5afd23ade`. This branch is not production. Roadmap and dependency boundaries are in `docs/engineering/production-integration-stages-2026-10-21.md`.
- **Stage A (portable path + safe test harness):** Imported validated `src/lib/v4/paths.ts` and `tests/v4/protocol-core.test.ts` from latest full candidate: reject malformed UTF-16 surrogate, non-portable Windows reserved names, trailing dot/space, forbidden characters and >255-byte components, while valid Unicode emoji remains. Migrated `scripts/run-tests.mjs` to unique create-only `.tmp/tests-*` directories to prevent parallel test artifacts from overwriting each other. Updated `scripts/run-soak.mjs` and renamed old `tests/soak/v4-5gib-stream.test.ts` to `tests/soak/v4-100mb-stream.test.ts` and fail-close above exactly **100,000,000 decimal bytes**. Updated discovery assertions and added `tests/v4/soak-size-policy.test.mjs`; no multi-GiB virtual or physical tests are run.
- **Stage B (scheduler only):** Imported `src/lib/v4/request-scheduler.ts`, `tests/v4/request-scheduler-observability.test.ts` and `tests/v4/request-scheduler-timer-drift.test.ts` from full candidate. This exposes queue/active/policy timer stats, paces concurrent write request starts through a gate, and supports an opt-out for rate-limit retries. The legacy default `retryRateLimits: true` remains until the complete GitHubClient+Runtime+recovery/cooldown stage is deliberately integrated; **GraphQL CAS and persisted cooldown are NOT on this master-derived branch**.
- **Validated after each stage:** `pnpm install --offline --frozen-lockfile` PASS; Build PASS; Stage A Fast **424/424**, Repeat 10/10 rounds each 424/424; after Stage B Build PASS, Fast **428/428**, Repeat **10/10 rounds each 428/428**, Recovery PASS, Resource PASS, Feasibility PASS, `validate:metadata`, `validate:package`, `test:github-e2e:compile` PASS; `test:soak` **1/1** defaulting to bounded **100,000,000-byte virtual cryptographic streaming**, SHA `f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8`. IMPORTANT: this older base's 1/1 virtual soak is NOT the full candidate's 6/6 real local encrypted push/pull soak; do not imply equivalence. No live GitHub/API writes or Native Obsidian UI tests were run for this partial staged build.
- **Still pending:** Groups C metadata/index and bounded storage, D journal/recovery/conflicts, E GraphQL CAS+GitHub Client+cooldown+Runtime+Settings/UI as an atomic dependency group, F UX/diagnostics and same-SHA native Obsidian encrypted E2E. Changes to persistent encrypted schema, conflict policy or Force semantics require explicit user decision. Never use GitHub Actions. No `master` Push/Release from this branch.

## 2026-10-21 PERMANENT OWNER POLICY: NEVER USE GITHUB ACTIONS

- **Explicit maintainer instruction:** "ไม่ว่าตอนไหนก็ตามเราไม่เอา GitHub Actions" — no GitHub Actions at any time. Do not invoke, dispatch, enable, configure, require, recommend, inspect run evidence from, or depend on hosted GitHub Actions for any operation, validation, or release. All historical instructions mentioning Actions gates or missing hosted CI are **superseded**. Zero Actions runs is intentional, **not** a release blocker.
- **Master integration COMPLETE 2026-10-21:** User explicitly approved bringing Local-only/No-Actions to `master`. Integrated only an **11-file** no-Actions change from parent `ef4f8e675a0be7d598c22b2ce88c843c1306c926`, creating commit `2202cbe5f966241cadc0ed580e3fde705a4cc4b5`. Normal non-force `git push origin HEAD:refs/heads/master` **SUCCEEDED**, and independently verified remote `master` exact SHA equals this commit; `git ls-tree -r --name-only HEAD .github/workflows` empty. No workflow was run/queried; no tag/release; original Zed checkout/untracked `AGENTS.md` unchanged. **530 other development commits were deliberately NOT merged**, including GraphQL strict-CAS and cooldown candidates; never claim those features are on `master`. Future release still requires user approval and local exact-SHA source gates only.
- **Master-based integration candidate:** Branch `audit/2026-10-21-no-actions-master-base` in isolated worktree `.tmp/no-actions-master-base-ef4f8e6` started from **actual `origin/master` at `ef4f8e675a0be7d598c22b2ce88c843c1306c926`**, not the ahead-by-530-commits feature branch. Apply ONLY the user-approved no-Actions changes from candidate commit `8b86161f36b395a8ecdecfbae03af2850860f46f`: delete four `.github/workflows/*.yml` plus obsolete workflow-only feasibility tests, replace their contract with fail-closed no-workflow assertion and local exact-SHA qualifier/release safety assertions, adapt docs/releasing.md and docs/github-e2e.md to the local-only release path. No V4 sync/encryption/ref/CAS/recovery implementation changes are authorized by this integration.
- **Local release authority:** Existing `pnpm qualify:local` and `pnpm release:local` remain the only approved qualifier/release path, with immutable exact source SHA, tested pinned disposable E2E repo ID, safe cleanup and receipts; NEVER execute release/qualification commands casually because they may mutate source tags/releases once preconditions hold. Never push, merge, or release without owner approval of the exact master integration scope. No Actions workflow is a valid fallback.
- **Master-based local verification:** `pnpm install --offline --frozen-lockfile` PASS, `pnpm build` PASS, `pnpm test:fast` **419/419 PASS**, `pnpm test:repeat` **10/10 rounds of 419/419 PASS** when run alone, `pnpm test:feasibility` **132/132 PASS**, `pnpm test:recovery` **43/43**, `pnpm test:resource` **11/11**, `pnpm validate:metadata`, `pnpm validate:package`, `pnpm test:github-e2e:compile` PASS. An overlapping Repeat run initially failed because multiple runners shared a fixed ignored `.tmp/tests` location; isolated rerun all green. There is no native Windows two-instance UI runner script on older master, so previous UI validation of the ahead branch must NOT be transferred as an exact-source native qualification of this master-based integration.
- **PREEXISTING master test-policy mismatch:** `scripts/run-soak.mjs` on the actual older master still defaults to **virtual** 2 GiB and 5 GiB cryptographic streaming tests, despite the user's hard maximum test size of **100,000,000 decimal bytes**. The master-based soak command passed but exposed this mismatch; no real multi-GiB test file was created. Never repeat those legacy virtual tests; fix the active script and related tests/baselines in a **separate narrowly scoped follow-up**, without silently including changes in no-Actions-only master integration. This preexisting discrepancy is a known item, not evidence of physical >100MB test-file creation.
- **Release readiness:** User-approved disposable live GitHub repository only `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform` ID **1284153873**. No personal vault mutation; max test file **100,000,000 decimal bytes**. Test via local Windows native Obsidian and unit/repeat/recovery/resource/feasibility/soak; physical mobile/macOS/Linux and genuine network interruption are outstanding before final release. Root user's Zed checkout and untracked `AGENTS.md` must remain untouched. **Full ahead branch had 530 additional commits** versus master; never merge it wholesale as an accidental side effect of removing Actions.

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

- 2026-09-26 (Asia/Bangkok)
- Reason: verify successful deletion of all safe cleanup branches and normalize the durable handoff to the final repository state.
