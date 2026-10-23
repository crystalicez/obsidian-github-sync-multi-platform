# Stage D22 — Async V4 staging sink lifecycle and failure cleanup (Node.js only)

Date: 2026-10-23. Audit-only stage in `audit/2026-10-21-staged-production-integration`.

## User direction and scope

Keep Node.js + Obsidian API as the production implementation. The OS pathname race/native helper research is frozen in [GitHub Issue #9](https://github.com/crystalicez/obsidian-github-sync-multi-platform/issues/9); **do not touch it until user explicitly requests**. This stage addresses a separate **in-process asynchronous sink lifecycle** weakness in `src/lib/v4/staging-store.ts`, not a path-swap/TOCTOU problem. No native binary, remote format or journal/WAL schema, restore policy, encryption, GitHub writer/reader or source checkout modification.

## Fail-first reproduction (RED with original source)

New deterministic Node tests at `tests/v4/staging-store.test.ts` use delayed fake staging backend writes to force operation-order interleavings without timeouts or real remote access.

1. **Concurrent append + premature finish:** Start a backend `write()` and suspend it, then call `append()` and `finish()` again without awaiting. Original `finish()` observed `total=0` while bytes were in flight and wrongly returned `V4 staged sink received 0 bytes; expected 3.` An overlapping second `append()` also saw `first=true` before first write finished, allowing a second initial `write()` to overwrite content rather than append. RED.
2. **Abort resurrects a stage:** Start delayed initial `write()`, call `abort()`, then release delayed write. Original code removed the partial stage before the delayed write completed, and the suspended writer recreated the stage **after cancellation** (test expected absent; found present). RED.

Focused suite initially **5 passed / 2 failed** (existing tests pass, two new fail-first regressions).

## Narrow fix / now enforced contract

- The sink serializes *backend operations* for one staged object via an internal promise queue. Already-accepted `append()` requests finish in order before `finish()` verifies bytes; concurrent initial writes cannot both take the first-write path.
- Explicit state `open | finishing | finished | aborting | aborted | failed` rejects late append or repeated finish. `finish()` is a terminal request; it waits for queued appends and accepts only a valid 64-hex SHA and **exact expected accumulated byte count**.
- `abort()` stops accepting writes synchronously, waits for outstanding backend work, removes partial state afterwards, and is idempotent; abort preempts a pending finalize, including a delayed **zero-length** initial write, so it cannot return a completed stage receipt after abort.
- First backend write/append error is retained across queued operations, further queued writes are suppressed, the partial stage is cleaned up best-effort, and a queued finalize rejects with the original error. Overrun and invalid finalize proof likewise clean partial bytes instead of retaining them.
- Existing sequential `stageSource()` and `V4SyncSession.stageRemotePull()` calls keep their prior API, record shape, hashes, codec and WAL policy. No new timer, filesystem rename/delete path-containment policy, cross-device protocol or native code.

**Limits:** This ensures *JavaScript in-process sequencing* of the staging backend calls, not OS-level fsync/power-loss durability; it does not solve GitHub Issue #9. A backend I/O operation that never resolves can still keep abort waiting, and an underlying storage failure preventing `backend.remove()` still means cleanup is best-effort; the error path never returns a valid stage receipt. Stage IDs are opaque. This is not a live Obsidian/editor/network E2E acceptance.

## Tests

- Focused after fix **11/11 PASS**: 6 new cases (overlapping appends/finish, delayed write/abort, queued write failure/finish, abort preempting finish, overrun + malformed proof cleanup, zero-length finish/abort) plus 5 existing compatibility cases.
- `pnpm build` PASS.
- `pnpm test:fast` **509/509**, after last new regression.
- `pnpm test:repeat` **10 rounds × 509/509**.
- `pnpm test:recovery` **79/79**.
- `pnpm test:resource` **11/11**.
- `pnpm test:feasibility` **132/132**.
- `pnpm test:soak` **1/1**, virtual streaming limit exactly **100,000,000 decimal bytes**, no physical >100MB file.
- `pnpm validate:metadata`, `pnpm validate:package`, `pnpm test:github-e2e:compile` **3 bundles** PASS.
- Git diff whitespace checks PASS. No GitHub live mutation, no real Obsidian GUI test performed this stage (prior D15 Windows small native journey, D14 full 1,000-note native peer acceptance remain historical, not re-proven here).

## Safety and remaining release work

The changed code is only `src/lib/v4/staging-store.ts`, the focused regression suite and engineering/HANDOFF notes. Do not reinterpret new sink safety as evidence for GitHub Issue #9. Independent production gates still include coordinated C2 remote-format evolution and line-level merge UX, cross-platform actual vault tests, actual NAS latency/durability and independent audit. No GitHub Actions, release/tag or master change; original Zed working checkout and untracked `AGENTS.md` untouched.
