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
- `pnpm test:fast`: 532/532 PASS, rerun again after final test-only diagnostics refinement with 532/532 PASS. `pnpm test:repeat`: 10 rounds × 532/532 PASS (before the additional observer-exception assertion, subsequently verified by focused codec 10/10 PASS).
- `pnpm test:recovery`: 79/79 PASS; `pnpm test:resource`: 11/11 PASS; `pnpm test:feasibility`: 134/134 PASS.
- `pnpm test:soak`: bounded virtual 100,000,000 bytes PASS, reference SHA matched; `pnpm test:github-e2e:compile`: 3 bundles; release metadata/package validation PASS; `git diff --check` PASS.

## Real Windows Obsidian — exact production/source SHA `b7105d00c9f47a66099ca6b7d2e65ed1f017ea60`

- Two isolated genuine Windows Obsidian instances and new synthetic vaults, encrypted GitHub remote, `--mode=encrypted --verify-peer --journey --assert-diagnostics --expected-repo-id=1284153873`: **PASS / exit 0**. Encrypted remote ciphertext validated, peer physically decrypted and restored note, Unicode rename/delete/recreate and simultaneous Copy conflict retained both revisions, UI exceptions **0**.
- Sender HTTP body counters: upload **4,809 bytes**, download **13,755 bytes**, **18** API requests, 0 API failures, **10,142.5 ms** summed API latency, 0 outstanding calls, sampled renderer RSS **202,186,752 bytes**. Peer: download **22,466 bytes**, **13** requests, 0 failures, **4,687.5 ms** summed latency, sampled renderer RSS **201,486,336 bytes**, and **0.199999988 ms** actually measured cumulative content-decryption calls. These are not peak physical RAM, raw wire throughput, hashing time, or total decryption wall-clock.
- Warm no-op: **~2,352.9 ms**, 5 API requests, 0 uploaded bytes and no-change. Peer Force Pull wall ~9,395.4 ms. Not a 100MB acceptance run.
- Disposable branch `obsidian-sync-e2e/local-b7105d00c9f4-743ffd246c3b8c56` was absent after runner cleanup and **independently read-only confirmed absent twice** (checker exit 0), pinned repository ID `1284153873`.

## Credentialed full GitHub E2E — exact production/source SHA `b7105d0`

- **3/3 suites PASS, exit 0**: six plaintext, six encrypted and controlled external-ref race scenarios, including delete/recreate, disjoint edits, rename against stale edit, keep-both conflict, binary overwrite, encrypted out-of-band write protection. All reported scenarios had zero retries/cooldown/unknown publication outcomes. Some HTTP 4xx counts are expected absence checks; this is **not** a claim every API request returned 2xx.
- Branch `obsidian-sync-e2e/local-b7105d00c9f4-d24-full-eac02d55c9f0` wrapper `CLEANUP_VERIFIED_TWICE`, independent read-only checker `READ_ONLY_CLEANUP_VERIFIED_TWICE`, exit 0, approved disposable GitHub repo ID `1284153873`.
- **P0 stays OPEN:** D38 full E2E failed with `Missing V4 remote object: Notes/reborn.md` in plaintext delete/recreate after source had independently loaded published immutable data; no root cause or engine change in D39. A single new GREEN matrix does not refute an intermittent failure. The missing-object diagnostic did not trigger in this passing run.

## Narrow post-E2E test-harness revision — SHA `baf48b4d246efb0794648c6df628aab3a1eee7a3`

- Test-only follow-up changes only `tests/github-e2e/v4-real-github-e2e.test.ts`: the diagnostic monitor preserves the original promise for unrelated `getFileBytes` paths; only `Notes/reborn.md` attaches a missing-result observer. `git diff b7105d0 baf48b4 -- src` was empty: same product source as full E2E/native SHA.
- On the amended clean test source, `pnpm build`, `pnpm test:fast` **532/532**, and three GitHub E2E bundle compilations PASS.
- Scoped live `delete-plaintext` **1/1 PASS exit 0**, branch `obsidian-sync-e2e/local-baf48b4d246e-d24-delete-plaintext-8dd99cf7b263`; scoped `delete-encrypted` **1/1 PASS exit 0**, branch `obsidian-sync-e2e/local-baf48b4d246e-d24-delete-encrypted-daea39c7f115`. Each distinct branch confirmed absent twice by wrapper and **separate independent read-only checker**, exit 0. No retries/cooldown/unknown outcome in these scenarios. These are **not a second full 3/3 matrix**.

## Still blocked before release

Intermittent real GitHub missing-object P0 requires root-cause evidence and fix/prolonged acceptance; Hashing and Encryption still have **no genuine standalone timing**, so strict 100MB telemetry cannot yet pass honestly. Actual 100MB native acceptance on this SHA, macOS/Linux, physical Android/iOS RAM, C2 remote-format qualification, line-level merge UX and independent security review remain open. Do not loosen GitHub CAS, collision/conflict rules or mutation pacing without explicit decision. No GitHub Actions, Native OS Helper Issue #9, merge or release.
