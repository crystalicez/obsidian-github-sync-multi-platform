# D58 — Re-qualify actual Windows Obsidian and full GitHub V4 E2E

Date: 2026-10-24 (Asia/Bangkok). Ledger-owned isolated worktree `.worktrees/d58-real-obsidian-acceptance`, audit branch `audit/2026-10-24-d58-real-obsidian`, directly from clean pushed D57 SHA **`042e3d7e86833377ebae155e6c42a5ba6ed42e59`**. ALL credentialed and native tests were executed from that **exact clean source SHA**. This is renewed, independent native/live acceptance after D51–D57; no `src/**` or test runner modifications, no production behavior changes, GitHub Actions, native helper, no-WAL/replay/retry/CAS/cryptography decisions, default/release merge or personal vault access.

## Strict external-test safety and cleanup

All live tests used only the previously owner-approved disposable repository `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform`, validated **numeric repo ID `1284153873`**, source repository identity checked and default/main branch never changed. Each live run independently required a clean source checkout, unique randomized branch absent at preflight, credentials from the owner-managed local environment file (never printed), and a synthetic vault/profile. Physical Obsidian tests used the installed Windows Obsidian application, a unique synthetic vault and CDP port, encrypted ephemeral passphrase, private secrets and screenshots removed by scoped cleanup. No test file exceeded **100,000,000 decimal bytes**. Production REST part-size policy stays **8 MiB**.

Each live branch passed its runner's cleanup verification and a **separate pinned-repository read-only verification** using `node scripts/check-github-e2e-branch-absence.mjs <exact-branch>`, requiring `READ_ONLY_CLEANUP_VERIFIED_TWICE` and exit 0. No residual test branch remains:

1. **Native two-Obsidian encrypted journey + UI**: `obsidian-sync-e2e/local-042e3d7e8683-71cbb8152c43cf50`.
2. **Native two-Obsidian 100 MB encrypted binary roundtrip**: `obsidian-sync-e2e/local-042e3d7e8683-684925598951e612`.
3. **Full GitHub E2E matrix**: `obsidian-sync-e2e/local-042e3d7e8683-d24-full-a8d716cb9962`.

## Real Windows Obsidian / Sync Center two-vault acceptance

Ran `node --env-file=../../.env.github-e2e scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --verify-peer --journey --assert-diagnostics --expected-repo-id=1284153873`. **PASS / exit 0**, `cleanup=absent-verified`, `remoteEncryptionVerified=true`, `peerRestored=true`, screenshot actually captured and then removed with ephemeral evidence, UI exceptions **0**. Source vault's Sync Center button drove real manual GitHub publish. The final remote encrypted tree was checked for authenticated ciphertext header, valid configuration and absence of leaked logical file paths. The second real Obsidian instance downloaded/decrypted/preserved expected notes. Tested Unicode nested paths, rename+modify+delete, delete/recreate and two-device simultaneous conflict with **both revisions retained**. A warm no-op manual sync returned `no-change`, zero mutations and did not advance GitHub HEAD.

Observed UI diagnostics at captured synchronized state on source: 18 API requests, **0** API failures, upload 4,809 bytes, download 13,755 bytes, API latency aggregate 9,012.2 ms, peak renderer RSS **186,884,096 bytes**, no in-flight requests at completion. Peer: 12 requests, **0** API failures, download 21,725 bytes, decryption 0.4 ms, peak RSS **192,065,536 bytes**. These are measurements from specific sampling points, not a universal performance guarantee. Independent remote branch checker **PASS** after native cleanup.

## Real Windows Obsidian exact 100,000,000-byte encrypted binary roundtrip

Ran `node --env-file=../../.env.github-e2e scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --verify-peer --native-100mb --assert-diagnostics --expected-repo-id=1284153873`. **PASS / exit 0**, `cleanup=absent-verified`, `peerRestored=true`, remote ciphertext verification PASS, UI exceptions **0**.

The source Windows Obsidian recognized, encrypted and uploaded the exact **100,000,000-byte** synthetic binary; the second real Windows Obsidian independently downloaded/decrypted/restored it with SHA-256 matching the fixture and earlier virtual-soak reference:

`f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8`

Source's observed 100 MB upload wall time **52,989.2 ms**, upload API traffic **133,345,125 bytes** (includes transport/encoding overhead, **not** binary size), 28 requests, API failures **0**, hashing **944.7 ms**, encryption **80.9 ms**, peak renderer RSS **314,454,016 bytes**, no unsettled in-flight API calls. Peer binary restoration wall time **37,201.8 ms**, download traffic **100,043,469 bytes**, 33 requests, failures **0**, decryption **70.5 ms**, hashing **465 ms**, peak RSS **235,110,400 bytes**. A separate warm no-op of the 100 MB vault also made no remote change or upload. Each figure reflects THIS execution only; remote traffic versus logical payload and total latency are distinct. Independent branch absence check twice PASS.

## Full credentialed GitHub E2E acceptance matrix

Ran `node scripts/run-github-e2e-disposable.mjs full` against approved repo. The **full suite passed 3/3 tests / exit 0**, reported `LIVE_E2E_PASS`, wrapper cleanup `CLEANUP_VERIFIED_TWICE`, independent read-only `READ_ONLY_CLEANUP_VERIFIED_TWICE` / exit 0. The original real-GitHub V4 runner logged **13 scenarios**: the baseline, stale catch-up/disjoint push, same-file copy conflict, rename-vs-stale-edit, delete/recreate identity break, binary overwrite **in both plaintext and encrypted modes** (12 runs), plus a controlled external branch-head race (1 run). Two additional separate tests covered rename-versus-stale-edit exact local-primary Copy contract and encrypted out-of-band mutation fail-closed. Full runner reported `tests 3, pass 3, fail 0`; measured runner duration **682,222.5157 ms**. The scenario telemetry recorded **0 retries, 0 unknown publication outcomes**; these are not claims that intermittent D38/D45 cannot recur.

The explicitly failure-triggered D47/D49 immutable-object/branch-head forensics are still present in E2E code. No unexpected missing immutable object or observed-null branch head was caught in D58, so there is **no new causal evidence** about those historical P0 errors.

## Offline quality gates

- Exact D58 source tested: Maximum Strict TypeScript PASS (0 errors), production esbuild PASS.
- Verified fresh D58 offline gates: fast **605/605 PASS**, repeat **10 × 605/605 PASS / exit 0** (ten independent round markers and ten 605-pass summaries from terminal output); recovery **79/79 PASS**, resource **11/11 PASS**, feasibility **134/134 PASS**, bounded virtual **100,000,000-byte soak 1/1 PASS**, GitHub E2E **3 bundles compile PASS**, metadata/package validators PASS.
- No further live GitHub or Obsidian scenarios should be attributed to D58 beyond those enumerated above.

## What this does NOT clear

D54–D57 WAL **partial multi-mutation replay** remains a release-blocking design risk (earlier Trash/finalized backup may precede later missing or corrupt stage). D38 intermittent missing immutable object and D45 intermittent pre-publish REST branch HEAD null remain unexplained despite renewed full live success. **No-WAL fallback A/B** (A reject mutating Pull without recovery store, recommended; B redesign safe bounded fallback) remains undecided. The earlier offered read-only all-stage preflight PoC **has not been authorized**, and the test run does not authorize any such change. Real Mac/Linux, Android/iOS best-effort background and crash/restart acceptance, independent security/C2 review, and vetted manual line-level merge integration remain incomplete. **Do not mark production ready**, merge default branch, or ship release from this audit worktree.
