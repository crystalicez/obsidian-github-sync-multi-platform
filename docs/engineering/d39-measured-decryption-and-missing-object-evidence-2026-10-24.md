# Stage D39 — genuine V4 content decryption timing and missing-object evidence

Date: 2026-10-24 (Asia/Bangkok). Isolated `.worktrees/d39-measured-decryption-evidence`, branch `audit/2026-10-24-d39-measured-decryption-evidence`, parent pushed D38 `5e12382589853a9b1b8b5fe8f0c1c9a5e17e51e6`. Original Zed checkout, main/release, user vault and credentials untouched. No GitHub Actions or native helper.

## Why and scope

D38's two-real-Obsidian encrypted strict diagnostics could not pass because the peer's `decryptionMs` was never measured; the functional peer journey independently passed. D39 measures the actual asynchronous V4 **content** `decryptV4Payload` invocation (single, pack, and parts), starting after resource-scheduler admission, and reports cumulative per-sync observed decryption durations. The observer is guarded so a broken telemetry handler cannot affect successful decryption or error behavior. Failed decrypt attempts are also measured, without claiming successful plaintext. Plaintext storage does not report decryption. This does not include metadata/index decrypts, GitHub network/downloading, queue wait, UI render, hashing, encryption, or physical device power consumption. `decryptionMs` stays absent/`not measured` when no measured attempt occurred; no fake zero or timing value is produced.

The session callback is optional under Maximum Strict `exactOptionalPropertyTypes`, and the runtime resets its cumulative value at the start of each run, persisting it for the finished Sync Center display. The UI now has a separate `Decryption` row. Encryption and Hashing remain explicitly unmeasured; strict native 100 MB cannot be claimed until measured separately.

The unresolved live GitHub plaintext delete/recreate P0 was **not** altered in the production reader, CAS, retry, WAL or conflict policy. Test-only `tests/github-e2e/v4-real-github-e2e.test.ts` records an immutable requested ref, local index SHA and local file IDs **only if** a synthetic `Notes/reborn.md` read returns missing. This is diagnostic evidence, not an automatic retry or proof of root cause, and it does not print tokens or bytes.

## Regression and offline evidence

- RED test before instrumentation: focused codec 9/10 passed, missing observer samples (`0 !== 1`).
- GREEN focused codec 10/10. Test covers real authenticated AES-GCM decryption with exact plaintext, corruption/rejected authentication with timing recorded, absent metric for plaintext, and observer exception unable to change the recovered data.
- `pnpm build`, `pnpm typecheck:max-strict`: exit 0, zero TypeScript errors.
- `pnpm test:fast`: 532/532 PASS; `pnpm test:repeat`: 10 rounds × 532/532 PASS (before the final nonfunctional extra assertion in the same test; focused rerun required).
- `pnpm test:recovery`: 79/79 PASS; `pnpm test:resource`: 11/11 PASS; `pnpm test:feasibility`: 134/134 PASS.
- `pnpm test:soak`: bounded virtual 100,000,000 bytes PASS, reference SHA matched; `pnpm test:github-e2e:compile`: 3 bundles; release metadata/package validation PASS; `git diff --check` PASS.

## Release gates

Live GitHub full matrix remained RED on D38 (2/3 suites); a passing focused retry did not establish an intermittent-race fix. Qualify D39's exact clean SHA with real Windows Obsidian encrypted strict telemetry and peer restore, then verify every test branch absent in an independent read-only process. Full GitHub E2E, actual 100 MB strict hashing/encryption timing, macOS/Linux, physical Android/iOS RAM, C2 remote compatibility, line merge UX, and independent security review are separate release blockers. No merge or release.
