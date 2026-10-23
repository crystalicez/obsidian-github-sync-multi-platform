# Stage D26 — Node.js content collection cancellation boundary hardening

Date: 2026-10-23. Isolated detached worktree `.tmp/d26-content-cancel-a6d89d9`, based on D24 audit SHA `a6d89d948bd0e9866104c62fe462ab2a32510296`.

## Boundary and user decision

Node.js + Obsidian API remains primary. [Issue #9](https://github.com/crystalicez/obsidian-github-sync-multi-platform/issues/9) (OS-level filesystem TOCTOU/native research) stays **deferred until user explicitly asks**, not part of this stage. No protocol, GitHub API, encryption, WAL, restore/Copy conflict policy, release, native helper, GitHub Actions, master or user's Zed checkout was modified. D24 concurrent uncommitted files are preserved untouched in the original audit worktree.

## Fail-first: accepted cancelled source output

Original `collectV4ContentSource(source, maximumBytes, signal)` forwarded an `AbortSignal` to the content source but **never independently checked the signal**. Sources may be non-cooperative (e.g., adapter async generators, delayed backend callbacks, or empty sources), violating the fail-closed expectation at the receiving boundary. Four deterministic tests were added to `tests/v4/content-source.test.ts`:

1. **Abort before empty collection**: source of size 0 did not need to yield; collector returned empty bytes instead of rejecting, and could call source unnecessarily.
2. **Abort while source yields chunks**: generator ignored the signal after a chunk; collector continued and returned full bytes.
3. **Abort after final chunk**: source raised cancellation between its last `yield` and iteration completion; collector reported success.
4. **Iterator cleanup on abort**: a non-cooperative generator's `finally` must execute after collector rejects, so source cleanup is not skipped.

The first three tests were observed **RED on original code** (focused 5 passed / 3 failed), establishing the underlying defect before implementing the fix. The fourth was added afterward to guard source iterator cleanup.

## Fix

`src/lib/v4/content-source.ts` now invokes the existing `throwIfV4Aborted(signal)`:
- after collection bounds validation and before allocating/iterating;
- immediately after each asynchronously yielded chunk, before validating or copying it; and
- after the async iteration finishes, before accepting complete size/output.

These boundaries preserve existing `V4CancelledError` semantics and API. They prevent a non-cooperative source from handing out apparently valid bytes after cancellation has already been observed. The changes make **no** new promise of forcibly interrupting an underlying I/O call that never resolves, of OS-level file access atomicity, or of power-loss durability.

## Evidence and residual qualification

Focused collection suite **9/9** PASS after fix (5 existing +4 new). `pnpm build` PASS, `pnpm test:fast` **514/514**, `pnpm test:recovery` **79/79**, `pnpm test:resource` **11/11**, `pnpm test:feasibility` **132/132**, `pnpm test:soak` **1/1** virtual stream capped at 100,000,000 decimal bytes, metadata/package validation PASS, GitHub E2E compile-only **3 bundles** PASS. `pnpm test:repeat` **10 rounds × 514** (gate results verified after run). No live GitHub network or native Obsidian run on this D26 SHA: last scoped real GitHub full E2E was D24 3 consecutive three-suite runs all PASS on D22-equivalent product `src/`.

External async iterator cleanup is demonstrated at the synchronous cancellation boundary; an unresolving source's `next()` still requires underlying cancellation support to avoid indefinite pending work. No additional live platform guarantee is claimed.

**Parallel D25 upstream evidence (to retain after safe rebase):** D25 independently proved a real Windows Obsidian encrypted two-instance functional journey on the same pre-D26 Node.js runtime (peer restore/rename/recreate and Copy conflict PASS), while its *strict diagnostic UI* gate failed because live GitHub/API/crypto/hash/peak-RAM rows are not wired into Sync Center. This independent UI instrumentation remains **unresolved**; it is not part of D26's narrowly scoped content source cancellation change.

## Isolation / release boundaries

The user-owned original Zed checkout `work/zed-production-hardening` and untracked `AGENTS.md` remain unchanged. The original D24 audit worktree has concurrent uncommitted/untracked changes by another process, deliberately not staged, removed or overwritten here. Only D26 isolated source, focused test, this report and `HANDOFF-NEXT-SESSION.md` are in scope. No release readiness claim: current-code real Obsidian GUI on platforms, C2 cross-device remote coordination, line-level merge UX and network drive/platform-specific durability remain independent qualification items.
