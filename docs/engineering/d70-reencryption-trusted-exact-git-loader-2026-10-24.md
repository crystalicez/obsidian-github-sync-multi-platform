# D70 — Re-encryption trusted exact-commit Git reader (read-only)

Date: 2026-10-24 (Asia/Bangkok).

## Intent

The Re-encryption Wizard is an owner-required first-release blocker. Destination architecture A (fresh history) versus B (same branch) is still unapproved. This stage **does not perform migration**, publish a branch, mutate tokens/settings, read the user's vault, or alter the release gate. It closes a prerequisite trust gap in the D69 verifier: callbacks must not accidentally read from the mutable Git branch.

## Exact-source reader

`verifyGitHubReencryptionSource` in `src/lib/v4/reencryption-trusted-loader.ts` accepts a narrowly typed, already authorized `GitHubClient` read surface: `getGitRef`, `getGitCommit`, `getTreeAt`, `getBlob`. It **does not use** `getFileBytes` (Contents API), publication APIs or Force Push/Pull. Callers must separately bind that GitHub client to the intended owner/repository; the explicit `expectedRepoId` and `expectedBranch` must match the observed ref and decrypted remote metadata. The source config is unencrypted metadata, but encrypted head/shards are authenticated using the old keyring.

The reader:
1. Validates the named source branch and verifies `refs/heads/<branch>`, `type=commit` and exact 40-digit lowercase Git SHA. It pins this SHA for **every later read**.
2. Traverses the exact immutable Git commit/tree/blob path using the repository's existing `readImmutableGitFile`. Tree/ref/commit SHA mismatches, unexpected node types, truncated tree ambiguity, missing files and wrong repository identity fail closed.
3. Decodes V4 config with production bounds (PBKDF2 <=1,200,000; canonical and <=64-byte salt); refuses plaintext/legacy unsupported layouts; derives an old keyring from provided passphrase and remote KDF parameters. The passphrase and keys never enter the report.
4. Reads/decrypts/authenticates V4 head and all declared index shards exclusively from the exact pinned commit and their required AAD.
5. Invokes D69's metadata inventory and all-live-object verifier using the **same immutable tree reader**; rereads mutable source HEAD before and after object verification and fails if it has changed.
6. Returns only a frozen verified-count report; best-effort zeroes decoded salt and derived keyring byte arrays in `finally`. As in JavaScript WebCrypto generally, zeroization cannot guarantee that all internal copies have been erased.

## Performance guard

Repeated immutable traversal otherwise fetches the same root Git commit and parent trees for every record (RED regression observed four commit lookups even for a one-file synthetic repository). D70 caches **only the immutable commit identity and small Git trees** within a single verification. Tree cache limits: max **8,192 total nodes**, max **2,048 nodes for an individual cached tree**; evicts older cached trees at the cap. Truncated/malformed/oversized tree responses are not cached. **Ciphertext blobs are never cached** in this layer; the D69 pack reader may still reread the same packed blob for multiple logical files. The cache is not shared between attempts/devices and cannot override final mutable HEAD checks.

## Verification and remaining risks

Red-green tests: the missing reader module initially failed compilation; after implementation, 7/7 passed; an additional query-count fail-first regression observed redundant commit fetches, corrected by bounded memoization; final focused D70 **9/9**. The tests simulate realistic encrypted config/head/shards/ciphertext using the real V4 codec and mocked Git tree/ref/blob APIs. They cover wrong branch/type, wrong passphrase/repo ID, over-cap untrusted KDF, invalid commit/tree identity, missing metadata, incomplete/truncated tree, mutable HEAD race, cancellation and result redaction. Full TypeScript/esbuild build, fast/resource/recovery/feasibility suites, E2E compilation and metadata/package validators passed.

**Limits:** This is not yet exercised against the live GitHub endpoint or an installed Obsidian Wizard UI. The caller still needs to create/pass an **appropriately scoped GitHubClient**; credentials and account/repo permissions are outside this function. SHA-1 is the Git object identifier and HTTPS+Git tree relationship are relied upon; the AES-GCM/sha256 checks also validate actual encrypted plaintext. The pre/post HEAD checks cannot detect ABA change-and-revert. No independent backup, WAL recovery, other-device stale-client fencing, migration publication or crash-resilient cutover has been completed.

**Release gate:** `docs/release-gates/reencryption-wizard.json` remains `status: blocked`. Topology choice A/B and the A branch-versus-new-repository choice still require explicit owner approval before any mutating implementation.
