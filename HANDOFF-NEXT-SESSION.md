# HANDOFF — NEXT SESSION

> Persistent handoff for the `obsidian-sync` project.
>
> **Mandatory workflow rule:** Every AI session that makes a material change to code, tests, design decisions, branch/PR state, verification status, or next steps MUST update this file before ending or handing work off. GitHub is the source of truth.

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
