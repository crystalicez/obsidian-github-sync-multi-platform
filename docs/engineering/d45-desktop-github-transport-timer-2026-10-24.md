# D45 — Recover Desktop-only GitHub transport Node timer without changing Sync policies

Date: 2026-10-24 Asia/Bangkok. Isolated worktree `.worktrees/d45-desktop-transport-timer`, branch `audit/2026-10-24-d45-desktop-transport-timer` from clean/pushed D44 `2eec58816ad5a0445378a85bbfe803ac482b8d38`.

## Worktree consolidation evidence

Read-only D43–D44 worktree audit found historical `src/lib/v4/desktop-transport-timer.ts` absent from current source even though its old `8a30a46` branch had actual Windows Obsidian acceptance. Current `V4RequestScheduler` uses renderer/global `setTimeout` by default. Obsidian/Electron background renderer clamping can stretch GitHub request pacing waits. This is a performance/lifecycle regression **relative to prior approved Desktop-only Node implementation**, not a reason to replace Obsidian UI timers or mobile policy.

## Restored, bounded behavior

- Restore historical `selectV4GitHubSchedulerSleep(isDesktop, nodeTimer?)`. It resolves `require('node:timers')` only when Desktop is detected; for Mobile it returns `undefined` without evaluating Node imports. No static imports of Node-only modules from mobile entrypoints.
- `FastSync.initGitHubClient` injects `sleep: selectV4GitHubSchedulerSleep(Platform.isDesktopApp === true)` into **GitHub request scheduler only**, with original transport policy, rate-limit cooldown persistence, abort behavior, mutation pacing, Git CAS, concurrency, and encryption settings untouched. UI scheduled sync, startup timer and mobile `setTimeout` remain unchanged.
- RED before recovery: focused test could not resolve historical timer module. GREEN: behavior tests cover 1000 ms mutation spacing (no early Git write), mobile no Node load, abort of policy sleep without sending a write, plus a contract assertion that the production GitHub client remains wired to Desktop-only selection. Those tests are not a substitute for native Windows acceptance.

## Verification

- Focused **4/4 PASS**, `pnpm typecheck:max-strict` zero errors and `pnpm build` PASS.
- `pnpm test:fast` **572/572 PASS**, `pnpm test:repeat` **10 × 572/572 PASS**, `pnpm test:recovery` **79/79**, `pnpm test:resource` **11/11**, `pnpm test:feasibility` **134/134**, bounded virtual 100 MB soak **1/1**, GitHub E2E three bundle compile, metadata/package validation PASS. Exact-SHA native qualification must be recorded separately after it completes; no claim until verified.

## Remaining branch consolidation and release blockers

The historical worktree audit still lists `automatic-wake.ts`, `platform-interval.ts`, `recovery-startup-policy.ts`, `shard-hash.ts`, `github-cooldown.ts` as source-path absences; most are not independent missing features, some were refactored and others are user-consent/OS-timer semantic decisions. Do not automatically merge them without parity proof and approval. D43 bounded line-review/File overview models are pure but not wired in UI. D38 intermittent missing-object P0 stays OPEN. No native helper binaries, GitHub Actions, default-branch merge/release, or physical file test above 100,000,000 bytes.
