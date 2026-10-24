# D71 — Git blob byte identity in pre-rekey trusted reader

Date: 2026-10-24 (Asia/Bangkok). Audit-only from D70 committed SHA `d2bf6ec`.

## Finding

In D70, `readImmutableGitFile` traverses an immutable commit → tree → blob chain, but its GitHub adapter returned the byte payload from `getBlob(sha)` without verifying that the **returned bytes** actually have the requested Git blob SHA. GitHub ordinarily supplies correct data, but a malformed response, proxy/cache issue or wrongly stubbed adapter could otherwise be accepted as Git-object-identical. Encrypted head/content still have AES-GCM and plaintext SHA-256 safeguards; the unencrypted V4 config lacks that independent encryption layer.

## Change (read-only)

`src/lib/v4/git-blob-identity.ts` computes the exact Git SHA-1 blob object ID for `blob <raw byte count>\\0` followed by the bytes. It incrementally processes 64-byte blocks with fixed scratch arrays and **does not copy the entire ciphertext into a second full-size buffer**, so it works on the 8 MiB new-part policy and legacy >8 MiB parts without a second logical blob allocation.

The D70 `verifyGitHubReencryptionSource` adapter now checks `assertV4GitBlobIdentity(bytes, requestedSha)` **before** handing config, encrypted metadata or ciphertext to the decoding pipeline. All paths remain exact-commit Git tree reads; mutable GitHub Contents API is not used. No mutation or migration APIs are introduced. The validation is fail-closed on malformed SHA or mismatched data and does not expose plaintext paths, passwords, keys or blob contents in its error message.

This SHA-1 calculation is **only the Git repository's existing object-addressing scheme**, not a new cryptographic security primitive and not a replacement for authenticated AES-GCM metadata/content or the plugin's SHA-256 plaintext verification. SHA-1 is not collision-resistant for adversarial document signatures. Git SHA-256 repositories or non-40-character object IDs are not silently supported by this V4 code.

## Verification

- Fail-first new `git-blob-identity.test.ts` initially failed because the helper did not exist; after implementing, tests **3/3** verify the Git SHA-1 object format against *independent* Node.js crypto oracle at 0, 1, 8, 55, 56, 63, 64, 65, 119, 120, 121, 4096, 65,537 and 8,388,609 bytes, wrong/missing IDs, corruption and nonmutation of caller byte arrays.
- Updated the D70 Git-tree test fixture to assign actual Git blob SHA IDs from Node.js crypto, not synthetic placeholders. A new fail-closed D71 regression intercepts `getBlob` and tampers with bytes while preserving the requested SHA; the bridge rejects it before KDF derivation. The existing KDF-over-cap test updates its tree entry to the **correct** blob SHA of its malicious but structurally valid metadata so that the KDF policy remains the expected failure. Focused trusted loader tests **10/10 PASS**.
- Frozen offline install, `pnpm build` (strict TypeScript/esbuild), full `pnpm test:fast`, `pnpm test:resource`, `pnpm test:recovery`, `pnpm test:feasibility`, `pnpm test:github-e2e:compile` (3 bundles), metadata and package validation all PASS.

## Remaining evidence boundaries

D71 was validated against mocked Git transport and independent cryptographic test vectors, **not live GitHub or installed Obsidian**. The new verification is applied only to the *read-only future re-encryption source reader*, not an unreviewed global change to all existing Sync API paths. Full release readiness still requires a live exact-SHA read on disposable encrypted GitHub test data, independent backup proof, fully implemented writer/wizard, WAL and crash/cancel recovery, multi-device stale-client cutover, mobile/desktop acceptance and independent audit. Pre/post HEAD sampling does not catch source ref ABA. No GitHub Actions or remote mutation.

The D66 `docs/release-gates/reencryption-wizard.json` remains blocked; owner choice A (separate fresh-history destination, recommended) vs B (same-branch rekey) is still pending. **No migration/ref/secret changes are authorized by D71.**
