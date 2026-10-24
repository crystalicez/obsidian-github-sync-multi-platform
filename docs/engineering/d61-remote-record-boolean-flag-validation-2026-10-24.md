# D61 — Reject malformed remote deleted/dirty flags before V4 sync planning

Date: 2026-10-24 (Asia/Bangkok). Isolated audit worktree `.worktrees/d61-remote-deletion-bool-guards`, branch `audit/2026-10-24-d61-remote-deletion-bools`, direct descendant of clean pushed D60 `3e54afcccdcd3203584af70eac006171df2da7e2`. **Exact committed source SHA** used for all D61 live tests: `2a305890d2df675f4fb567705efa34878d9cf372`.

## Scope and security concern

Only production source `src/lib/v4/remote-index.ts`, matching `tests/v4/staged-remote-descriptors.test.ts` and engineering/handoff documentation were changed. No GitHub Actions, native helper, user vault, original root/Zed checkout, historical D45 WIP, default/release merge, CAS/publish retry, missing-remote-object semantics, encryption/wire format, WAL/recovery/no-WAL policy, conflict/deletion policy, or REST part-size (fixed **8 MiB**) was changed. All GitHub mutations were confined to the previously user-approved disposable repository **ID 1284153873** on preflight-absent branches; each branch was independently verified gone twice after scoped cleanup.

The V4 record interface declares optional `deleted` and `dirty` flags as booleans, but `assertNormalizedRemoteRecord` did not check either field's runtime type after parsing untrusted GitHub metadata. The actual `sync-session.ts` logical-record conversion uses `records.filter(record => !record.deleted)`. A malformed `deleted: "false"` is truthy in JavaScript and therefore excludes the file, despite semantically resembling false. An invalid flag should not be silently normalized or interpreted as a deletion. This is a **metadata trust-boundary correctness/safety flaw**, not direct evidence of an attacker deleting a native vault in production.

## Deterministic fail-first proof and minimal source fix

New test `D61 untrusted remote deletion and dirty flags must be actual booleans` covers both `assertV4RemoteRecordSet` and `decodeV4RemoteShard` with JSON bytes. Reject `deleted: "false"`, `"true"`, `1`, `null`, `[]`, `{}`; reject `dirty: "false"`, `0`, `null`. Preserve all combinations of absent, actual `false`, and actual `true` fields (no metadata migration).

**RED** before production fix: existing focused tests **10/10 PASS** but new test failed with `Missing expected rejection: string false deletion`, focused **10 pass / 1 fail**. **GREEN**: add only two explicit type checks to the existing record validator, raising generic `V4 remote record deleted/dirty flag is invalid` errors before logical planning or GitHub object reads. No serialized protocol or interpretation of valid boolean flags changed. Focused suite **11/11 PASS** after patch, with Maximum Strict TypeScript **0 errors** and production build PASS.

## Fresh offline qualification

- `pnpm.cmd install --frozen-lockfile` PASS.
- Maximum Strict TypeScript `tsconfig.maximum-strict.json` **0 errors**, esbuild production bundle PASS.
- Focused descriptors **11/11**; full fast tier **610/610 PASS**; fast repeat **10 × 610/610 PASS / exit 0**, independently verified ten repeat-round markers and ten 610-pass summaries.
- Recovery **79/79**, resource **11/11**, feasibility **134/134**, virtual bounded **100,000,000-byte** crypto soak **1/1 PASS**, E2E **3 bundle compile PASS**, release/package validators PASS and staged Git whitespace check PASS.

## Fresh real Obsidian on Windows: encrypted two-instance user journey

Command: `node --env-file=../../.env.github-e2e scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --verify-peer --journey --assert-diagnostics --expected-repo-id=1284153873`.

Code SHA `2a305890d2df675f4fb567705efa34878d9cf372`, unique approved disposable branch `obsidian-sync-e2e/local-2a305890d2df-e5d97a8cc3155a9a`. Preflight branch absence and repo ID verified. **PASS / exit 0** from actual installed Windows Obsidian on two independent temporary synthetic vaults/profiles; ciphertext and opaque remote layout proof, Unicode nested note and scratch creation, combined rename/modify/delete, delete/recreate, simultaneous conflict retaining both edits, second Obsidian decrypted restore, warm no-op sync with **zero remote commit/mutations**, Sync Center telemetry available, **0 UI exceptions**. Sampled first instance API requests **18**, API failures **0**, peak renderer RSS **183,697,408 bytes**; peer **13** requests, failures **0**, RSS **193,134,592 bytes**. All temporary vault/profile/screenshot artifacts scoped to runner cleanup, branch `absent-verified`. Independent pinned-repo read-only branch checker: **`READ_ONLY_CLEANUP_VERIFIED_TWICE` / exit 0**. D61 native run was a normal notes journey, **not** a physical 100 MB test (the last exact 100 MB real Obsidian acceptance was D59).

## Fresh full GitHub E2E matrix

Command: `node scripts/run-github-e2e-disposable.mjs full` from **same committed and clean source SHA**. Unique preflight-absent branch `obsidian-sync-e2e/local-2a305890d2df-d24-full-c78a2f5e7053`, approved repo ID 1284153873 only.

**3/3 tests PASS / exit 0**, main real-GitHub V4 runner reports 13 scenarios: baseline path roundtrip, two-device stale catch-up/disjoint push, same-file Copy conflict, rename vs stale edit, delete/recreate identity break, and binary overwrite in both **plaintext and encrypted modes**, plus controlled external branch-head race. Other tests specifically assert stale rename local-primary Copy semantics and reject encrypted out-of-band remote mutations without silent overwrite. The full suite reports `LIVE_E2E_PASS`, **0 retries / 0 unknown publication outcomes** in scenario telemetry, **682,239.4365 ms** overall; runner `CLEANUP_VERIFIED_TWICE`. Separate independent read-only checker **`READ_ONLY_CLEANUP_VERIFIED_TWICE` / exit 0**. Test remote branch removed, original GitHub default branch not changed.

No unexpected D38/D45 intermittency was observed in this full run, **which does not prove either P0 is resolved**.

## Remaining release blockers and user approvals

- D38 intermittent `Missing V4 remote object` and D45 pre-publish branch HEAD 404/`observedHeadSha=null` remain open, underlying cause not proven. Do not introduce speculative retry/CAS changes.
- D54–D57 **partial WAL multi-mutation replay** remains open (early Trash or finalized original backup before later stage is missing/corrupt). The previously proposed isolated read-only all-stage preflight PoC is **not authorized** by generic continue; do not alter replay semantics or start PoC without explicit approval.
- D50 **no-WAL fallback A/B** remains unanswered. A = require a recovery store / fail closed for mutating Pull (recommended); B = bounded safe fallback redesign. Do not choose for user.
- Real macOS/Linux and physical Android/iOS, real power-loss recovery on all supported platforms, independent security/C2 review, integrated audited line-level manual merge UX remain unqualified.
- **Not production-ready**, no default-branch merge or release.
