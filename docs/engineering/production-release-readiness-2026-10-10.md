# Production release readiness snapshot — 2026-10-10

> This is a dated **audit-branch readiness record**, not release approval or a replacement for `docs/releasing.md`. Evidence belongs to an exact commit, not a branch name; refresh this record whenever the source SHA changes.

## Source and decision boundary

- Canonical repository: `crystalicez/obsidian-github-sync-multi-platform`; release branch: `master`.
- Open draft audit PR: [#8](https://github.com/crystalicez/obsidian-github-sync-multi-platform/pull/8), `audit/2026-09-26-production-hardening`.
- Snapshot audit tip at review start: `ccc3ebc5e1cf2e707c1c9e885447421e6ffc580f` (`fix: verify encrypted publication journals`).
- The tip contains follow-up fixes for encrypted object and journal publication authentication; see commits `135b961`, `ce92998`, and `ccc3ebc`. The persistent handoff predates the final journal fix and must be refreshed.
- An unrelated local edit in `tests/v4/github-transport.test.ts` was present before this readiness pass. Preserve it; it is **not** evidence of a clean exact-commit checkout.
- Review/documentation commits and pushes to the audit branch are allowed. No merge, stable tag, release publication, or destructive real-GitHub E2E is authorized by this document.

## Required gates before production approval

| Gate | Required evidence | State at snapshot |
| --- | --- | --- |
| Close production audit | Independently review and resolve current regressions, risky tree/journal changes and tracked WIP; document residual risks | Open PR #8; review outstanding |
| Freeze source | Clean checkout of current `master`, immutable full commit SHA, coherent metadata | Not done |
| Deterministic qualification | Exact `v24.11.0` Node, pnpm `9.12.3`, frozen install, build, fast ×1, fast ×10, recovery, resource, feasibility, E2E compile, metadata/package validation | Audit-workspace checks run separately; **not** master qualification |
| Hosted CI | Successful current-attempt CI of exact master SHA and artifact provenance | No current audit-SHA run found; investigate Actions execution before release |
| Live GitHub | Exact-SHA qualification on isolated disposable target with pinned numeric repo ID; cleanup verified | Not run for this candidate |
| Devices | Real desktop/mobile smoke tests for claimed platforms; verify sync/conflicts/offline/restart/upgrade | No new physical evidence |
| Windows 5 GiB | Force Push → no-op → clean-vault Force Pull SHA-256 equality and controlled recovery with bounded-memory measurements | `tests/baselines/v4/windows.json`: pending |
| Android 5 GiB | Supported bounded read and atomic stage commit on device, then physical evidence | Unsupported; keep capability-failed |
| Release qualification and assets | Official exact-SHA `pnpm qualify:local` receipt, `pnpm release:local -- <version>`, stable ref/draft/asset digests verified | Not run; requires maintainer release decision |

### Hosted Actions observation (2026-10-10)

The public GitHub Actions runs API returned `total_count: 0` for audit commit `3886c33f6810eb95a37046ed585bd90fc6640aff`, even though the push succeeded. The most recent runs visible through the repository-wide API were dated 2026-08-16. This **does not prove** that Actions is disabled, but it means there is currently no hosted CI evidence for this pushed audit tip. Check repository Actions permissions, workflow eligibility, and the Actions run UI before treating the PR as CI-qualified. The official local exact-SHA release path remains available independently, but do not silently substitute audit-workspace checks for release authority.

The connected Windows host reports Node `v24.11.0` and Corepack pnpm `9.12.3` (matching repository pins), but an attempted read-only `gh api` preflight returned `EXECUTABLE_NOT_FOUND` for `gh`. This host therefore cannot yet execute the official local qualification/release commands; provision an authenticated GitHub CLI on the chosen release machine before invoking them. No global tooling was installed during this pass.

## Safe, autonomous follow-up

1. Complete deterministic audit-branch verification without running the credentialed or destructive live suite.
2. Review late encrypted publication object/journal changes against the writer contract; add focused RED regressions and minimal fixes if defects are demonstrated.
3. Preserve unrelated uncommitted edits rather than silently staging them or declaring a pristine checkout.
4. Update `HANDOFF-NEXT-SESSION.md` with exact commit IDs, gate output and outstanding decisions; push review/doc changes to the **audit branch only**.
5. Prepare an independent review checklist for the PR; do **not** merge PR #8 or rebase/force-push without explicit maintainer decision.

## Maintainer decisions / external prerequisites

1. **PR merge:** approve the reviewed audit diff and decide when to merge to `master`; no automatic merge.
2. **Live test target and authorization:** select an initialized disposable private GitHub repository, pin its numeric ID and tightly scoped token, and authorize destructive E2E there. Never point it at notes or the source repository.
3. **Platform claims:** decide the minimal physical Windows/macOS/Linux/Android/iOS smoke matrix and whether a 5 GiB Windows result is mandatory before this release or specifically excluded from its claims. Android multi-GiB remains unsupported.
4. **Security acceptance:** decide whether to accept the bounded-transport limitation, general Git-tree semantic response equivalence residual, keyring retirement lifetime and remote metadata pre-parse bounds, or require deeper hardening.
5. **Publication:** choose the stable version and publication window, after the exact `master` SHA has passed qualification. Do not bypass the intentionally disabled Actions Stable Release workflow; use the supported local exact-SHA path.

## Residual engineering risks to sign off

- Obsidian `requestUrl` buffers bodies before size validation; a forged large remote response can temporarily exceed the writer memory envelope. Post-buffer byte checks are not an actual bounded transport fix.
- General `createGitTree()` successful responses are object-ID-shape validated but not yet proven semantically identical to the requested base-tree-plus-edits. Prefer a bounded authenticated Merkle proof; naive recursive tree scans are not safe.
- A settings-invalidated keyring may remain retired until runtime disposal while old history work retains it. Lifetime/reference tracking needs design before more aggressive zeroization.
- Metadata/history fields have protocol-specific validation but no universal pre-parse byte ceiling.
- `esbuild ^0.24.2` remains a dev-tooling hygiene finding; source does not use the affected dev-server `serve()` path. Upgrade separately with real pnpm/lockfile and build evidence if prioritized.

## Commands and acceptance

Non-destructive source gates:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm validate:metadata
corepack pnpm validate:package
corepack pnpm test:fast
corepack pnpm test:repeat
corepack pnpm test:recovery
corepack pnpm test:resource
corepack pnpm test:feasibility
corepack pnpm test:github-e2e:compile
```

These gates are necessary but **not sufficient** for publication. The official local `qualify:local` and `release:local` commands mutate remote state when prerequisites are satisfied and must not be used as audit smoke tests. See `docs/releasing.md` and `docs/github-e2e.md`.
