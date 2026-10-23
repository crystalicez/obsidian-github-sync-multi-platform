# Stage D25 — Fail-closed Node.js staging space numerical validation

Date: 2026-10-23. Isolated branch `audit/2026-10-23-d25-staging-space-precision`, branched from committed D24 state `a6d89d948bd0e9866104c62fe462ab2a32510296`. **This branch exists separately because the primary audit worktree contained unrelated uncommitted files, including edits to HANDOFF. Those files were not copied, touched, staged or deleted.**

## User decisions and isolation

- **Node.js + Obsidian API first.** GitHub [Issue #9](https://github.com/crystalicez/obsidian-github-sync-multi-platform/issues/9) is deferred until explicit user direction; native handle/race research was neither reopened nor integrated.
- This change affects only ordinary **numeric input correctness** in `src/lib/v4/staging-store.ts` and associated tests. It does **not** change the GitHub wire format, WAL, filesystem pathname operations, encryption, conflict policy or platform support.
- No Actions, master, tags, releases, personal vault or physical test files above 100,000,000 decimal bytes. Dependencies in the new separate worktree were installed from offline cache with frozen lockfile.

## Fail-first (RED) observed before fix

Three deterministic tests exposed three independent acceptance problems:

1. `estimateV4StagingSpace` accepted individually valid `stageBytes` and `existingTargetBytes` whose sums exceed `Number.MAX_SAFE_INTEGER`, returning silently rounded `peakFootprintBytes` or `additionalFreeBytesRequired`. A space estimate cannot be exact at that magnitude.
2. `beginStage` accepted invalid declared `expectedSize` or `existingTargetBytes` values such as `NaN`, `Infinity`, negative numbers, fractions and integers above the safe range; it could return a sink without failing before any potential write.
3. For a staged object above the configured whole-buffer ceiling, a backend could return `NaN`, `Infinity` or fractional/unsafe free-space estimates. The original `available < required` comparison is **false for NaN**, erroneously allowing staging to proceed. `undefined` was already handled; other untrustworthy numeric forms were not.

The focused test suite failed on all **three** new cases against the unmodified source. All values are **virtual numeric inputs**; none allocated huge files or buffers.

## Narrow correction

- Validate `expectedSize` and `existingTargetBytes` as **nonnegative safe integers** at the very start of `beginStage`, before choosing a stage ID, reading free space or mutating storage.
- Compute `additionalFreeBytesRequired` and `peakFootprintBytes` then reject with `RangeError` if either sum falls outside the exact safe-integer range; preserve exact boundary values that remain representable.
- For large staging, treat backend `freeBytes` as **unknown** unless it is a nonnegative safe integer, reusing `V4UnknownStagingSpaceError` (existing fail-closed UI/contract) rather than interpreting invalid metrics as space available.
- The normal source and backend paths, small-stage compatibility behavior, actual file bytes, rollback evidence and stage receipt shape are unchanged.

## Acceptance evidence

- Focused `staging-store` tests **14/14 PASS**, including 3 new cases.
- `pnpm build`, `pnpm test:fast` **513/513**, `pnpm test:recovery` **79/79**, `pnpm test:resource` **11/11**, `pnpm test:feasibility` **132/132**, `pnpm test:soak` **1/1 with virtual 100,000,000-byte stream**, `pnpm validate:metadata`, `pnpm validate:package`, and `pnpm test:github-e2e:compile` (3 bundles) PASS.
- `pnpm test:repeat` **10 rounds × 513/513 PASS** on the scoped D25 source and test tree.
- No real GitHub E2E or Obsidian GUI was repeated for this scoped numerical validation. D24's previous 3 full real-GitHub E2E runs remain historical baseline **on the previous committed product SHA**, not tests of D25.

## Boundaries and next steps

This is **not** a fix for physical disk exhaustion after a valid free-space check, device write failures, concurrent OS path swaps, directory metadata durability or GitHub eventual ref propagation. The local production-readiness gates still include latest-code real Obsidian GUI acceptance, coordinated C2 remote-format changes, line-by-line conflict merge UX, cross-platform/network-drive evidence, and independent review. Nothing in this change alters [deferred Issue #9](https://github.com/crystalicez/obsidian-github-sync-multi-platform/issues/9).

The D25 change was isolated on its own audit branch to avoid staging unrelated parallel edits in `.tmp/staged-production-6c67c8a`. **Do not push this branch over the existing audit branch or force-merge without first reconciling those unrelated uncommitted files.**
