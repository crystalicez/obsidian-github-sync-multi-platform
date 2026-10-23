# Stage D38 — integrate measured-rate UI refresh with Maximum Strict TypeScript

Date: 2026-10-24 (Asia/Bangkok). Branch: `audit/2026-10-24-d38-strict-telemetry-integration`, created at D37 `4588820b904502959b4c1729052e4ff599770629` in the existing isolated `.worktrees/d37-max-strict-index-safety` checkout. The original Zed checkout, release/master, personal vault, GitHub Actions and deferred native OS-helper issue #9 are untouched.

## Source and behavior

D35 independently committed a follow-up Sync Center UI fix at `fb189b9123eaf0de3af90ab5d8472758cde2f67c` after D36 branched. D37 already contained the underlying D35 GitHub transport/RSS instrumentation but not this last elapsed-time refresh. D38 reconciles that exact behavior with the mandatory D37 Maximum Strict compiler without a format, encryption, Git CAS, retry/pacing, conflict or deletion policy change.

The Sync Center's `Upload API` / `Download API` rates are whole-run average measured **HTTP payload body bytes/s**, **not wire throughput** or instantaneous bandwidth. If elapsed time advances without a changed payload counter, the average must fall accordingly. D37 cached only `diagnostics` object serialization, so its UI showed a stale average even while the live `Total` timer updated. D38 includes elapsed time in the diagnostics render signature **when diagnostics exist**, but keeps its signature `null` when metrics are unavailable so timer ticks do not cause needless empty diagnostic DOM repaints. Hashing/encryption timing remains explicitly `not measured`; no fabricated zeros or peak physical memory claims.

## Reproducible verification

- **RED first on D37 code:** Added the user-facing fake progress source regression, advanced elapsed time from 1,000ms to 2,000ms with `uploadBytes=2048` unchanged. Focused test **7/8 PASS, 1 FAIL**: `run avg 2.0 KiB/s` remained instead of `run avg 1.0 KiB/s`.
- **GREEN on D38 code:** Focused Sync Center **9/9 PASS**, including this live text correction and a new assertion that absent diagnostics do not repaint on elapsed ticks; existing unsubscribe, live region and history render checks still pass.
- Maximum strict `pnpm typecheck:max-strict` **0 TypeScript errors** and full `pnpm build` **PASS**.
- `pnpm test:fast` **530/530 PASS**; `pnpm test:repeat` **10 rounds × 530/530 PASS**.
- `pnpm test:recovery` **79/79**, `pnpm test:resource` **11/11**, `pnpm test:feasibility` **134/134** PASS.
- `pnpm test:soak` virtual bounded **100,000,000 bytes PASS**, digest matches reference. Maximum generated physical test file remains 100,000,000 bytes.
- `pnpm test:github-e2e:compile` three bundles compiled; `pnpm validate:metadata` and `pnpm validate:package` both PASS; `git diff --check` exit 0 (Windows LF-to-CRLF warnings only).
- Product code/test commit: `00d3732efab0b9f637e7cb8c8298b36509a1d561`.

## Approved disposable-repository live E2E (exact code commit `00d3732`)

- **Full matrix NOT GREEN:** `node scripts/run-github-e2e-disposable.mjs full` exited **1**, tests **2/3 passed**. Plaintext scenarios baseline, stale catchup/disjoint pushes, Copy conflict and rename/stale edit passed, then the `two-device-delete-recreate-identity-break` scenario failed during device B Pull with `Missing V4 remote object: Notes/reborn.md`. Device A had already published and independently read its new-generation blob from an immutable published commit in the same scenario. This evidence does **not** establish root cause; stale ref/metadata/object visibility or a runtime bug requires independent diagnosis. Preserve the intermittent GitHub Sync P0.
- **Focused repeat GREEN but inconclusive:** Fresh separate `delete-plaintext` disposable run on the **same** code commit passed 1/1 and exited 0, with no reported GitHub retries, cooldown or unknown outcomes. A single passing rerun cannot qualify the failing full matrix or justify changing rate-limit/CAS policy.
- **Safe test-branch cleanup:** Full branch `obsidian-sync-e2e/local-00d3732efab0-d24-full-406c6aa0290e` and focused branch `obsidian-sync-e2e/local-00d3732efab0-d24-delete-plaintext-e10bfca9f86f` both returned wrapper `CLEANUP_VERIFIED_TWICE`; two **separate read-only verification processes** returned `READ_ONLY_CLEANUP_VERIFIED_TWICE` with exit 0 for each, pinned test repo ID `1284153873`. No source repo/default branch was mutated.

## Still to qualify before release

Full GitHub E2E must be GREEN and the intermittent missing-object failure understood before release. Exact-SHA Windows two-Obsidian acceptance remains pending at this checkpoint. Offline mocks cannot prove network, GUI or mobile behavior. Full 100MB strict diagnostics remain blocked by missing real hashing/encryption/decryption timing; current UI deliberately reports `not measured`. Linux/macOS, actual Android/iOS resources, C2 format coordination, merge UX and independent security review remain separate unresolved gates. No merge or release authorization is implied.
