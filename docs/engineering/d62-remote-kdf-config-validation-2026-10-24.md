# D62 — Fail-closed GitHub remote KDF configuration validation

Date: 2026-10-24 (Asia/Bangkok). Isolated ledger-owned `.worktrees/d62-remote-kdf-parameters`, audit branch `audit/2026-10-24-d62-remote-kdf-validation`, based directly on clean/pushed D61 `937c37a10dc45a588ee1ed97708594124699d037`. **Exact committed clean code SHA used for both D62 live tests: `c4759228b8c04c4083eadafe2218714871482170`.**

## Scope / preservation

Change limited to `src/lib/v4/remote-index.ts` (remote config decoder), `tests/v4/remote-index.test.ts` and documentation/handoff. Also removed an inadvertently duplicated D61 summary from canonical `HANDOFF-NEXT-SESSION.md` without losing its primary D61 entry. No GitHub Actions, default/release merge, root/Zed worktree modification, D45 inherited unstaged WIP, personal vault, native helper, encryption protocol/keys, Git CAS/remote-missing/retry, local deletion, recovery/WAL/no-WAL or 8 MiB REST part-size policy change. Every live GitHub branch was randomized/preflight-absent in the previously owner-approved disposable repository, numeric ID **1284153873**; test size <= 100,000,000 decimal bytes.

## Confirmed trust-boundary issue (RED then GREEN)

GitHub V4 `config.json` is parsed to a TypeScript `V4RemoteConfig` without runtime validation of optional `algorithm`, `kdf`, and `kdfParams`. In particular, `kdfParams.iterations: "600000"` (a JSON string) was accepted and could reach `V4KeyringCache.get` and WebCrypto PBKDF2 key derivation, contrary to the declared numeric contract; malformed salt and shape could likewise reach byte decoding. This is a remote-input validation gap, **not evidence that an attacker obtained encryption keys**.

New `D62 remote KDF fields reject malformed types and salt before key derivation` regression in `tests/v4/remote-index.test.ts` rejects string, missing, zero, negative, fractional and unsafe-integer iterations; null/array/empty/bad-Base64URL salts; null/array KDF params; unsupported AES/KDF names. It positively verifies the regular 600,000-iteration AES-GCM + PBKDF2-SHA-256 config and the **legacy encrypted config with omitted KDF fields** is still decodable.

**Fail-first RED:** focused test suite failed with `Missing expected exception: string iteration`. **GREEN:** the config decoder now rejects invalid top-level JSON shapes, unsupported optional `algorithm` / `kdf`, malformed `kdfParams`, iterations that are not positive safe integers, or invalid/non-string Base64URL salt spelling. Throws generic errors without echoing untrusted values. No valid stored config migration or change to the default PBKDF2 iterations **600,000**. Focused suite **12/12 PASS**.

**Intentionally deferred owner policy:** No new *upper* PBKDF2 iteration cap. A very large **positive safe integer** can still cause high derivation cost or be rejected by WebCrypto. Choosing a maximum and handling existing valid configs are security/performance/compatibility policies requiring explicit owner approval. Salt checks validate safe Base64URL shape, not cryptographic entropy or an independent KDF design review. No native helper or cryptographic algorithm change.

## Local quality gates — fresh D62

- Frozen package install PASS; production esbuild PASS; Maximum Strict TypeScript `tsconfig.maximum-strict.json` PASS **0 errors**.
- Focused remote-index **12/12 PASS**; full fast tier **611/611 PASS**; repeat **10 × 611/611 PASS / exit 0** with 10 distinct round markers + 10 matching pass summaries verified from completed runner.
- Recovery **79/79 PASS**, resource **11/11 PASS**, feasibility **134/134 PASS**, virtual cryptographic **100,000,000-byte** bounded soak PASS, E2E compile **3 bundles PASS**, release metadata/package validators and Git whitespace staged check PASS.
- D62 native Obsidian test used a normal small-note journey, not a physical 100 MB run. Latest physical 100 MB Windows acceptance remains D59; latest full GitHub **3/3** live matrix remains D61 (same shipping source except this decoder guard).

## Fresh live real Windows Obsidian: encrypted two-instance journey

Command `node --env-file=../../.env.github-e2e scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --verify-peer --journey --assert-diagnostics --expected-repo-id=1284153873`, exact clean source `c4759228b8c04c4083eadafe2218714871482170`, unique preflight-absent branch `obsidian-sync-e2e/local-c4759228b8c0-037b5f9de186b357`.

**PASS / exit 0:** installed Windows Obsidian on two temporary independent synthetic vault/profile instances; verified remote encrypted ciphertext/opaque layout, actual UI Sync Center, Unicode nested files, rename+modify+delete, delete/recreate, simultaneous two-device conflict retained both user revisions, peer decrypted restore, warm no-op no GitHub remote mutation. **0 UI exceptions**, source **19 API requests/0 API failures**, peak renderer RSS **190,353,408 bytes**; peer **13 requests/0 failures**, peak RSS **198,111,232 bytes**. Scoped cleanup reported `absent-verified`; independent pinned-repository read-only `scripts/check-github-e2e-branch-absence.mjs` reported **`READ_ONLY_CLEANUP_VERIFIED_TWICE` / exit 0**. Synthetic profiles/vault/screenshots were managed by the existing controlled runner. No personal vault touched.

## Fresh live GitHub encrypted two-device delete/recreate

Command `node scripts/run-github-e2e-disposable.mjs delete-encrypted`, **same clean source SHA** and approved repo ID 1284153873, separate preflight-absent random branch `obsidian-sync-e2e/local-c4759228b8c0-d24-delete-encrypted-66541056c82d`.

**1/1 PASS / exit 0**, exact two-device delete/recreate identity-break scenario: device A **45 requests/23 expected mutations**, device B **14 requests/0 mutations**, **0 retries**, **0 unknown publication outcomes**, no in-flight requests remaining. Runner reported `CLEANUP_VERIFIED_TWICE`; an **independent** read-only checker reported **`READ_ONLY_CLEANUP_VERIFIED_TWICE` / exit 0** after cleanup. No new full E2E matrix run in D62, and neither D38 nor D45 intermittent P0 was recaptured here.

## Release blockers / decisions

1. D38 intermittent immutable remote-object missing and D45 pre-publish branch ref 404/observed-null P0 remain causally unresolved despite passing scoped/full tests; do not add retries or declare these fixed.
2. D54–D57 multi-mutation WAL replay remains non-atomic (earlier Trash/finalization may precede later missing/hash-mismatched stage). The all-stage preflight PoC is **not approved**, and D50 no-WAL fallback A vs B remains an explicit owner choice. No replay semantics change authorized.
3. A potential *upper PBKDF2 iteration bound* is an owner security/compatibility decision, not silently imposed in D62. Current validation only requires a positive safe integer.
4. Real macOS/Linux/Android/iOS, physical crash/power-loss acceptance, independent security/C2 audit and audited line-by-line manual conflict merge integration remain release gates.

**Not production-ready; do not merge default/release branch from this audit checkout.**
