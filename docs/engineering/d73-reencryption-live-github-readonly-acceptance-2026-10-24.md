# D73 — Live GitHub read-only source verification for pre-rekey Wizard

Date: 2026-10-24 (Asia/Bangkok). Base D72 `9a5d6c2caf55d304a59b4c45bae1b875b0fedd0e`. Audit-only worktree: `.worktrees/d73-rekey-live-readonly-e2e`.

## Target and safety

The owner previously authorized **only** `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform` for disposable GitHub API integration, numeric repository ID **1284153873**. The new scenario reuses the existing manually invoked E2E guard and cleanup path; never touches canonical source repository, default branch, user vault, or release.

`scripts/run-github-e2e-disposable.mjs readonly-rekey-encrypted`:
1. Verify the GitHub test repository ID, default branch and source repository separation.
2. Generate a random **`obsidian-sync-e2e/local-*`** branch; prove its **absence twice** before any mutation.
3. Run `runReencryptionReadOnlyScenario` from `tests/github-e2e/v4-real-github-e2e.test.ts`.
4. Create a synthetic encrypted 7-file V4 vault with a fixture-only `forcePush` (this **writes test data** solely to the guarded disposable test branch; this is not a re-encryption/migration write). Wait until GitHub REST sees the published commit ref.
5. Construct a **fresh independent GitHubClient**, then call `verifyGitHubReencryptionSource` with the synthetic passphrase and **no write-capable methods in its selected interface**. Independently check exact pinned commit, file count, total bytes, remote object count, and zero **new** transport mutations from the verification client. Inspect the ref again to prove the verification did not move it.
6. Cleanup only the randomized branch, check absent twice in the E2E wrapper, then perform a **separate read-only absence verification** through `scripts/check-github-e2e-branch-absence.mjs` (also two distinct absence reads).
7. Include this scenario both as a standalone focused manual mode and in the manual `full` GitHub E2E acceptance path, so future full tests exercise the new proof.

## Observed live results (same stage code before final full-mode hook)

- Repo ID: **1284153873**, exact disposable branch:
  `obsidian-sync-e2e/local-9a5d6c2caf55-d24-readonly-rekey-encrypted-11ef147ea86e`.
- Live encrypted source commit: `824bddf5e324bf75d59f8c51cf70e13d4825e5b3`.
- The real V4 encrypted fixture was validated: **7/7 files**, **7 distinct remote objects**, total logical plaintext **1,048,689 bytes** (includes Unicode paths, binary bytes, empty file, and a 1 MiB file).
- Independent read-only verifier: **33 GitHub API requests**, **0 GitHub mutations**. The fixture writer had **20** GitHub mutation requests before the read-only verifier started; do **not** conflate these with a zero-write test setup.
- GitHub E2E: `LIVE_E2E_PASS`, runner exit **0**, GitHub branch cleanup reported success and `CLEANUP_VERIFIED_TWICE`.
- Independent cleanup verification (read-only separate script): `READ_ONLY_CLEANUP_VERIFIED_TWICE`, exit **0**.
- No GitHub Actions, force push/pull to a user's actual branch, remote deletion beyond the proven exact disposable test branch, or release operation.

## Boundaries and outstanding release work

- This live test validates **the read-only pre-rekey path** through D68–D72, not re-encryption itself. The verifier only examines objects referenced by *live* records. Deleted objects in history and clones remain out of scope.
- The live 7-file fixture exercises real single-object content; the D69 **multipart** (>8 MiB) and **shared pack** authentication checks are covered by existing local crypto tests, **not by this particular live GitHub scenario**. The new scenario remains well under the owner's **100 MB** physical test-file maximum; REST new part policy stays 8 MiB.
- The E2E runs in Node.js with the test Obsidian request bridge and in-memory vault, **not inside native installed Obsidian**. Native Windows, macOS, Linux, Android and iOS acceptance remains open for the Wizard.
- Source ref pre/post checks cannot exclude an ABA change-and-revert or new device edits after verification. Multi-device fencing, WAL/restart recovery, backup integrity, secret rotation, target publication and cutover still need owner-approved architecture and implementation.
- D66 `docs/release-gates/reencryption-wizard.json` **remains blocked**; all seven release acceptance checks are still pending. A (isolated new Git history, recommended) vs B (in-place) and A's repository versus branch destination choice remain **unapproved**.

## Reproduction

From this isolated worktree, after loading the approved local credential file in the parent project folder, run `node scripts/run-github-e2e-disposable.mjs readonly-rekey-encrypted`. This command **creates and deletes a disposable test branch** as documented above. Do not run against an unapproved GitHub repository. A later independent absence check takes the exact generated branch identifier, never an arbitrary user branch.

Strict TypeScript/esbuild, GitHub E2E compilation, full fast/resource/recovery/feasibility suites and metadata/package validations are recorded in the D73 handoff. No CI/GitHub Actions.
