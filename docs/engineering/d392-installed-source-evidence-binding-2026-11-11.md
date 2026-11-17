# Stage D392 — pin installed Source evidence bytes to authenticated GitHub E2E parent

Date: 2026-11-11 (Asia/Bangkok). All code and tests remain in the inherited D87 audit worktree. Only the approved disposable GitHub repository (numeric ID `1284153873`) and synthetic temporary Obsidian Vaults were used. No release, real Vault, permanent branch, Settings/Index Cutover or Wizard Execute.

## Why the additional check exists

D391 verifies the encrypted GitHub Source in an independent E2E process. It then transfers a token-free JSON inventory to a separate installed Obsidian process to run exact physical Source parity and encrypted WAL tests. The child originally validated the JSON structure and one known note hash but did **not** authenticate that the **exact manifest bytes** matched what the GitHub E2E parent wrote. In a hostile or unreliable local test environment, the file could change after parent verification and before the child read. The installed result could then be misattributed to a different Source tree.

D392 fixes this **test-evidence provenance gap** without inventing new production trust claims. The parent computes SHA-256 over the raw UTF-8 manifest, passes the digest as a separate `--evidence-sha256` child argument, and the child checks the raw file bytes **before parsing JSON, creating the disposable Obsidian test root, or starting an Obsidian process**. The shared `scripts/installed-source-evidence-digest.mjs` helper uses strict 64-hex digest validation and constant-time comparison. No token, old passphrase or key material enters the installed process.

A deliberately edited Source tree SHA retains the same file length, remains a valid 40-character Git SHA and preserves valid JSON. The E2E test launches the child with the original digest and requires the exact digest mismatch error before any installed success. It restores the original evidence in a `finally` block and runs D391's installed normal, same-size note tamper and lease-revocation cases unchanged.

## Reproduction and verification

- RED: `node --test tests/feasibility/installed-source-evidence-digest.test.mjs` failed with `ERR_MODULE_NOT_FOUND` before the helper was introduced (task `b41d7ef8-fd88-4f20-85fc-fe592a0c6ba1`).
- GREEN: the two digest-contract tests passed (task `5dda89e1-8ddf-4bcc-98cc-9bb868086aa2`), covering exact bytes, equal-size changed Source tree, omitted, malformed and substituted digest values.
- `pnpm typecheck:github-e2e` exited 0 (task `a8a32f29-50e4-4091-8a41-adcf980eb0df`), `pnpm test:github-e2e:compile` built all three E2E entrypoints (task `b3d51e2d-9ef4-4409-962f-93b3d195624f`), and `node --check scripts/run-obsidian-disposable-wal-authoring.mjs` exited 0 (task `73cefcdd-c592-4def-a9e3-72d4e2168f3a`).
- **LIVE PASS:** `node scripts/run-github-e2e-disposable.mjs installed-source-parity-encrypted`, task `cec86987-be17-4849-aa8a-7b05cad9c8e7`, exited **0**. The tampered-manifest child was rejected before installed Obsidian startup. All three subsequent installed normal, tamper and revoked-lease cases passed, with process restart and physical WAL readback. One focused GitHub E2E passed. The disposable Source branch `obsidian-sync-e2e/local-65046b2929db-d24-installed-source-parity-encrypted-bd97016c4018` was `CLEANUP_VERIFIED_TWICE` on exact repository ID `1284153873`, followed by `LIVE_E2E_PASS`.

## Limits and release decision

SHA-256 binds the parent-provided bytes to the child input. It is **not** a signed remote GitHub attestation or protection against a compromised E2E parent, attacker-controlled process arguments, or a malicious installed Obsidian process. The installed plugin still does not independently authenticate GitHub Source credentials; this is a safer test pipeline, **not an installed end-to-end re-encryption feature**.

Do not enable Wizard Execute or Cutover on this evidence. The first release still requires Sync and Re-encryption together, with the 8 MiB part policy, Mobile initiation <=32 MiB, best-effort Manual Recovery, separate test Vaults and no GitHub Actions. The remaining blocker is a single installed, genuinely authenticated Source-to-Backup-to-Staging-to-Destination WAL transaction and subsequent restart-safe Settings/Selector/Index and stale-device qualification.
