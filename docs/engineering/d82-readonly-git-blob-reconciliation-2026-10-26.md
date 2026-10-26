# D82 — Read-only Git blob receipt reconciliation, including live orphan E2E

Date: 2026-10-26 (Asia/Bangkok). Base clean pushed D81 `d0699ddca1dd22e0d787cedc286bef7f55d201e4`.

## Background and target

D79 stages all re-encrypted immutable blobs; D80 persists encrypted upload intents and matched receipts; D81 connects the two and leaves unresolved intents after ambiguous network outcomes. There was **no read-only way to ask GitHub whether the expected Git blobs are currently retrievable** before choosing a manual recovery workflow. Importantly, GitHub 404 on unreachable / recently created immutable Git blobs, transient 5xx, 429, failed auth and timeout are **not reliable proof the upload never happened**.

## Implementation / trust boundary

New `src/lib/v4/reencryption-blob-reconciliation.ts` exports `verifyStagedV4ReencryptionGitBlobs({plan, journal, github, maxObjects?, signal?})`, a **read-only per-run Git-object audit**, not an operation to resume migration, promote receipts or publish a branch.

- Validate D74 **same-physical-repository orphan branch plan**, exact pinned source commit, destination repo identity, and immutable D80 journal identity. Load an authenticated D80 snapshot; require `requiresRemoteRevalidation:true`, `permissionToPublish:false`, `cutoverAuthorized:false`.
- Reuse D80's original strict receipt validator (including safe opaque remote paths, 40-character Git SHA and <=8 MiB ciphertext). Reject duplicate WAL object paths before any Git read.
- Validate numeric GitHub repository ID **and** owner/repo full name before and after independent blob reads; throw if switched. The client must be scoped to the approved physical GitHub repo; these checks cannot by themselves prove confidentiality or branch reachability.
- Read immutable Git objects by the **receipt SHA**, never by mutable branch HEAD/Contents API. Verify the returned `Uint8Array`, exact ciphertext byte length (<=8 MiB) and complete Git blob SHA-1 over `"blob <length>\\0" + content`. This only verifies Git object identity, **NOT AES-GCM decryption, source-to-destination parity, a backup, or commit/tree reachability**.
- Treat **ALL Git GET failures**, including 404, timeouts, network exceptions, rate limit and auth errors, as `inconclusive`, not `absent`. No automatic retries, deletions, uploads, WAL promotion or repairs. A returned object whose bytes or SHA disagree is an **integrity failure** and throws, never an acceptable absent result.
- Re-read the journal at end; reject generation/content changes observed during audit. Bound a single audit to at most 4,096 objects (default 2,048); if the journal exceeds the limit, **skip remote bytes entirely and mark all inconclusive** rather than falsely approving a partial sample. Large vaults need a future paged verifier.
- Return a **frozen, sanitized aggregate**, with status `verified` (only that the Git blobs are now readable by SHA) or `inconclusive`, plus counts. The report *always* has `integrityScope:"git-blob-by-sha-only"`, `requiresRemoteRevalidation:true`, `destinationContentVerified:false`, `permissionToPublish:false`, `cutoverAuthorized:false`. Do not use `verified` as a re-encryption Wizard completion or recovery authorization. Even a `verified` pending intent **remains pending** in D80.

## Tests and actual GitHub live evidence

New fail-first suite `tests/v4/reencryption-blob-reconciliation.test.ts` **10/10 passed**: confirmed and pending reads without WAL changes; 404/timeout/429/500 inconclusive; malformed/mismatched size and Git SHA fail; wrong/changed numeric GitHub repo ID; wrong source/destination journal binding; missing journal/cancellation; oversized batch; mid-audit changed journal generation; invalid object path; no mutate/retry/cutover controls.

Enhanced the **existing, strictly guarded** `orphan-root-encrypted` manual GitHub E2E scenario (not a new real migration workflow). The test creates a **synthetic** encrypted note and zero-parent orphan root on a random disposable branch in the **sole owner-approved test repo ID 1284153873**. After second independent GitHubClient decrypts and verifies the note from its pinned commit, D82's read-only audit authenticates its staged ciphertext blob SHA through real `getBlob` and asserts a pending intent is NOT promoted, no git write, and source branch remains unchanged.

- Command: `node scripts/run-github-e2e-disposable.mjs orphan-root-encrypted` **PASS** (exit 0; `LIVE_E2E_PASS`).
- Disposable branch: `obsidian-sync-e2e/local-d0699ddca1dd-d24-orphan-root-encrypted-06be393e93ed`
- Synthetic zero-parent root SHA: `25b375f1cc45e3c8eb53f009d8f0da71f0c1406d`
- The independent synthetic GitHub blob audit `status:verified` with 1 matched pending object; `permissionToPublish:false`; it left the pending intent and WAL unchanged. The second-device **API client** had 0 mutations (not an installed second Obsidian instance).
- D75 parent/source tests continued to pass: root parentCount 0; source unchanged; 1 encrypted note decrypted.
- E2E harness confirms `CLEANUP_VERIFIED_TWICE`; separately ran `scripts/check-github-e2e-branch-absence.mjs <exact branch>`, got `READ_ONLY_CLEANUP_VERIFIED_TWICE` (exit 0). The GitHub test necessarily uploaded synthetic blobs and deleted only its randomized test branch. **Unreachable Git objects may persist.**

`pnpm install --offline --frozen-lockfile`, strict production `pnpm build`, full `pnpm test:fast`, `pnpm test:resource`, `pnpm test:recovery`, `pnpm test:feasibility`, `pnpm test:github-e2e:compile` three bundles, `pnpm validate:metadata`, `pnpm validate:package` all passed. No GitHub Actions or changes to main/master/real vault.

## Production blockers and owner decision

D82 does NOT resume uploads, commit a new orphan destination, build/publish a complete rekey metadata index, verify independent backup or durable WAL fsync, handle cross-process locks/mobile suspension, or guarantee complete destination readback at an immutable *published Git commit*. Exact source-to-destination plaintext checks on a real installed Obsidian second device remain mandatory. A Git object by SHA can exist while no branch/tree points to it. D66 Re-encryption Wizard release gate remains `blocked`: topology approved, other 6 checks pending.

The owner has approved Option A **new orphan branch in the same physical GitHub repository retaining the original branch for recovery**, but has NOT answered whether all old-branch devices must pause Sync throughout migration/cutover. Do NOT silently choose client freeze or reconciliation behavior.

**Next safe work:** independently verify a complete staged destination Git tree/commit (including all expected object SHA paths and encrypted V4 HEAD/index) with read-only exact-commit traversal, then secure backup proof, native local WAL durability / cancellation recovery, and independent two-Obsidian-device restore. Do not publish a real migration branch or cut over devices without explicit approval and complete evidence.
