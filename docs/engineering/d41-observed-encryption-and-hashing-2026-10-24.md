# D41 — observed content encryption and SHA-256 hashing timings

Date: 2026-10-24 (Asia/Bangkok). Isolated audit worktree `.worktrees/d41-measured-crypto-timings`, branch `audit/2026-10-24-d41-measured-crypto-timings`. Based on clean/pushed D40 `7a4dfcd7ae40a0cb9ddbe06f4d6a42fc08887dc8`. The original Zed/root, main/release, personal vaults, GitHub Actions and deferred native helper Issue #9 are untouched.

## Observability contract

- **Encryption:** Real elapsed time for authenticated AES-GCM **content payload** encryption only, inside the existing crypto resource admission. Covers small/single, content packs, streamed singles/parts and whole-buffer part writer. Does **not** include crypto queue wait, disk/network I/O, path HMAC, key derivation, remote metadata encryption or Git upload. Plaintext mode never emits synthetic encryption samples.
- **Hashing:** Measured SHA-256 content operations, including local scan small WebCrypto hashing, large incremental scans (timing only `update`/`digest`, not source reads/stability awaits), codec single and pack content verification, streamed push source verification and staged/pulled content hashes. Some other protocol/metadata hashes and the historical whole-buffer chunk-reassembly helper are **not** observed; this is not total CPU time or complete whole-application hashing cost. Samples represent observed work only. Hash timings from each executed operation sum across concurrent work; summed durations need not equal wall elapsed.
- **Decryption:** D39 real authenticated payload timing remains independent. Only observed samples are included in `V4RunDiagnostics`; no synthetic zeros from phase labels or elapsed totals. Per-run counters reset at `execute()` start, accumulate through attempts and are available to the existing Sync Center Hashing / Encryption / Decryption rows.
- **Correctness:** Measurement observers run through guarded try/finally and cannot change bytes, errors, source identity, cryptographic AAD, wire format, Git API requests, CAS/retry, conflict/delete policy or streaming resource accounting. Observers do not log key/plaintext material.

## Fail-first tests and offline verification

- RED before code: two new codec tests reported 0 real encryption and hash samples rather than 1/2; added independent assertion for plaintext no fake encryption. GREEN after codec instrumentation: focused codec **12/12 PASS** (includes previous decryption/failure behavior).
- Added measured incremental SHA test: exact digest matches WebCrypto after two updates, expected three observer callbacks (2 updates + final digest), observer exceptions swallowed. Added run diagnostics test for independent 12.5 ms decrypt / 7.25 ms encrypt / 4.5 ms hash with no invented fields when unobserved.
- Frozen offline install, `pnpm typecheck:max-strict` 0 TypeScript errors after enforcing `exactOptionalPropertyTypes` on observer option, `pnpm build` PASS.
- Fast **538/538 PASS**, repeat **10×538/538 PASS**, recovery **79/79**, resource **11/11**, feasibility **134/134**, virtual bounded 100,000,000-byte soak **1/1**, GitHub E2E compile three bundles, package and metadata validation PASS. `git diff --check` PASS.

## Qualification and release boundaries

After clean commit, run the genuine Windows Obsidian two-instance encrypted 100,000,000-byte journey with `--native-100mb --assert-diagnostics`, verify Upload, Download, actual Hashing, Encryption, Decryption and sampled renderer RSS. It is essential to distinguish **real 100MB uploaded/downloaded** from the virtual soak. Each disposable branch must be independently checked absent twice. Any timeout, failure or insufficient quota is RED, not a conditional PASS.

The intermittent D38 plaintext `Missing V4 remote object: Notes/reborn.md` P0 is still OPEN. D40 GitHub full E2E 3/3 PASS did not establish its cause. Other release gates include macOS/Linux native tests, physical Android/iOS background best-effort, C2 wire/format review, line-level merge UX and independent security review. No merges/releases or GitHub Actions.
