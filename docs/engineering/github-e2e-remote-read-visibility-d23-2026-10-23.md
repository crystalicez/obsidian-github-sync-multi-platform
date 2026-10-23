# Stage D23 — Real GitHub E2E read-visibility diagnosis, not production acceptance

Date: 2026-10-23. Audit worktree `audit/2026-10-21-staged-production-integration`, starting product SHA `acdce29ae6958e531e582e78432959e712ecb0b7` (D22 async sink).

## Scope and immutable decisions

- Node.js + Obsidian API primary; native-helper / filesystem OS TOCTOU [Issue #9](https://github.com/crystalicez/obsidian-github-sync-multi-platform/issues/9) **explicitly deferred** — do not touch without user instruction.
- D23 modifies **only tests and engineering docs**. No `src/`, `package.json`, remote wire format, WAL, encryption, conflict policy, release/master, or GitHub Actions modifications.
- Live test destination exclusively `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform`, pinned numeric repository ID **1284153873**, using ignored root `.env.github-e2e` secrets without displaying or modifying them. Every mutation uses disposable `obsidian-sync-e2e/local-acdce29-*` branch, independently verified absent before use and deleted/absent afterward. Never mutate the source repo, default branch or personal vault.

## Initial full run — FAILED, branch cleaned

Full manual `scripts/run-github-e2e.mjs` on disposable branch `obsidian-sync-e2e/local-acdce29-d22a1b2c3d4`:

- Independent initial preflight: repository ID 1284153873, branch absent twice; default branch `main`.
- The separate real GitHub tests **Copy contract rename vs stale edit** and **Encrypted external out-of-band commit refusal** passed.
- Main dual-device suite passed plaintext baseline / stale catchup / Copy conflict / rename vs stale edit then failed plaintext `two-device-delete-recreate-identity-break` with `Missing V4 remote object: Notes/reborn.md` during peer Pull. Other modes not completed.
- Test hook independently deleted disposable branch and confirmed absence after exit (including repeat read-only check). The missing object is a **real observed transient/behavioral failure** and is not explained away by assertion changes. Without full commit/tree/HEAD evidence from that moment, causality (REST ref visibility vs publication defect vs read path) remains **unproven**.

## Controlled diagnosis and tests

- Added deterministic two-device separate delete/recreate regression to `tests/v4/sync-session.test.ts`: publish generation one, force pull B, delete/publish, recreate at same path/publish generation two with **new file ID**, then stale B normal pull. In-memory Git tree contains generation-two bytes, B receives correct bytes/ID. Focused Sync Session **88/88 PASS**, entire Fast **510/510**.
- Strengthened real `tests/github-e2e/v4-real-github-e2e.test.ts` delete/recreate proof: after source publish, `waitForBranchHead` requires the **exact published SHA** to become visible via REST; fetch corresponding immutable commit and tree; require candidate object path in tree; use `V4StorageCodec.read` to **verify decoded** content equals generation two for either plaintext or AES-GCM encrypted. This is a test barrier, **not a Sync Engine runtime fix or retry**.
- Focused plaintext delete/recreate run **three times PASS** on independent absent-first/cleaned branches (initial focused + `d23repeatA` + `d23repeatB`). One external independent check after a completed cleanup hit a temporary network error; retry confirmed **absent twice**, so no leftover branch.
- Focused encrypted delete/recreate **PASS** and cleanup absent twice.
- First subsequent full GitHub matrix `d23full1` progressed through entire plaintext matrix and four encrypted scenarios but failed at the new encrypted raw-blob-vs-plaintext assertion. **This was a test bug:** an encrypted object begins `OGS4` and cannot be compared directly to plaintext. Changed proof to decode through the V4 codec; focused encrypted verification then passed. Branch cleanup verified.
- Second subsequent full GitHub matrix `d23full2` passed two independent real GitHub tests plus plaintext baseline, stale catchup and same-file Copy conflict; failed `two-device-rename-vs-stale-edit (plaintext)` because fresh peer did not yet expose stale edited lineage bytes. Branch cleanup absent verified. **The original rename test lacked a wait for B's exact published ref SHA** prior to C's fresh Force Pull (a barrier already used in stale catchup). It could therefore falsely report lost bytes after C reads an older REST ref, but this cause is **not yet proven** for the recorded failure. Do not claim actual data loss or full resolution from this evidence.
- Added the same exact-SHA `waitForBranchHead` barrier **plus assertion C used that SHA** in the rename-vs-stale-edit live test. Added opt-in manual scenario filters for focused plaintext/encrypted delete–recreate and rename–stale-edit; the default E2E matrix stays unchanged.
- `pnpm test:github-e2e:compile` (3 bundles) PASS after these test changes; **no full end-to-end run with the final rename visibility guard has yet been verified**. **FULL LIVE E2E GATE: NOT GREEN.** Keep this as an active non-native production acceptance gap, separate from deferred OS race Issue #9.

## Local gates after diagnostic test changes

- `pnpm build` PASS; `pnpm test:fast` **510/510**; `pnpm test:repeat` **10×510**; `pnpm test:recovery` **79/79**; `pnpm test:resource` **11/11**; `pnpm test:feasibility` **132/132**; `pnpm test:soak` **1/1**, virtual streaming bounded to 100,000,000 decimal bytes; metadata and package validation PASS.
- `pnpm test:github-e2e:compile` **3 bundles** PASS after the final exact-SHA guard changed the E2E harness. This is compile-only; it does not establish full live acceptance.
- Live E2E was performed through the user-authorized disposable GitHub test repository; it is an in-memory-vault multi-device suite, not real Obsidian UI or OS vault acceptance.

## Risk and next step

Do not weaken Copy conflict byte-preservation assertions, silently add risky runtime overwrite/retry behavior, or claim E2E acceptance. To qualify fully, run the focused plaintext+encrypted rename-vs-stale-edit scenarios on fresh absent-first disposable branches; ensure `waitForBranchHead` and peer SHA proof hold; repeat **all 3 live suites**; verify each disposable branch absent after. If peer receives incorrect bytes **while it demonstrably read B's exact commit SHA**, treat that as a true potential data-integrity defect, preserve evidence, create a narrowly scoped regression and fix only with user-approved semantics. If failures occur only reading stale refs, assess controlled read visibility / bounded retry with separate tests and established UX; do not guess.

Outstanding unrelated release blockers remain C2 coordinated remote protocol migration, line-level conflict merge UI, platform-specific acceptance, network-drive best-effort and independent audit. No production ready claim based on D23.
