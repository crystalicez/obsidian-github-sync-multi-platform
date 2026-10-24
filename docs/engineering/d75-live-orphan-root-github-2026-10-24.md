# D75 — Live GitHub orphan-root encrypted branch acceptance (synthetic)

Date: 2026-10-24 (Asia/Bangkok). Base: pushed D74 `177e22d66e605b75a8cf766c61144d2f73c8e09c`. Audit worktree `.worktrees/d75-orphan-live-e2e`.

## Approved architecture and this stage's boundary

The owner approved option A: **a new Git branch in the same physical GitHub repository, with a new root commit containing zero parents and no old-branch ancestry**, fresh V4 encryption material, old source preserved, independent second-device restore before per-device cutover. The owner **has not answered** whether all old devices must remain paused for the entire migration/cutover window; no runtime freeze/fencing policy is silently selected in D75.

D75 confirms actual GitHub behavior for creating **a synthetic encrypted orphan root and a brand-new ref on an exact, previously absent disposable test branch**. This is not a real migration, not complete re-encryption of an existing vault, and not an independent installed Obsidian second-device acceptance test.

## Real E2E execution path

New manual mode `node scripts/run-github-e2e-disposable.mjs orphan-root-encrypted` reuses the existing safety harness:

1. Require the **sole owner-approved test repository** `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform` with pinned numeric GitHub repo ID **1284153873**; inspect its default branch and source ref read-only.
2. Generate a randomized `obsidian-sync-e2e/local-*` target; prove absence **twice** before any write. The default/source branch is never mutated.
3. Build a **synthetic encrypted V4 note with a Unicode logical path**, a fresh random KDF salt and keyring derived for the **new destination branch repoId**; produce AES-GCM ciphertext, encrypted HEAD/index and unencrypted V4 config. The synthetic source config is *not* loaded from or attributed to an actual prior vault.
4. Upload only new immutable Git blobs, build a new Git tree with **no `base_tree`**, create a Git commit with **`parents: []`**, then fetch the commit and run D74 `assertV4OrphanReencryptionRoot` against a distinct default/source tree SHA and source/destination configs. Also confirm that source HEAD and numeric physical repository ID remain stable and target ref remains absent in two separate reads.
5. Invoke **`createGitRef`**, not `updateGitRef` or force update, for the twice-absent randomized branch; wait for exact new SHA visibility.
6. Use a **fresh independent GitHubClient** to run D72–D69's exact-source reader, Git blob SHA-1, AES-GCM authentication, remote shard signatures and plaintext SHA-256. Assert one fully authenticated live note, zero verification-client mutations, an unchanged default/source branch, and **zero new root commit parents**.
7. Cleanup only that approved randomized ref; require the wrapper's twice-absent check and then independently execute `scripts/check-github-e2e-branch-absence.mjs` with the exact branch ID and require two more absence observations. Never clean arbitrary preexisting branches.

The scenario is included in manual focused mode **and** the manual full GitHub E2E suite; there are still **no GitHub Actions**.

## Actual live evidence

- E2E branch: `obsidian-sync-e2e/local-177e22d66e60-d24-orphan-root-encrypted-a5e8a5d18e7f`
- Exact new orphan root Git commit: `1fb6f2548fce03375f38d48cf73b82d841ffb48d`, **parentCount = 0**
- Synthetic encrypted file verified from exact Git commit: **1/1**; independent read-only verification client mutations: **0**; default/source branch unchanged: **true**
- Runner result: `LIVE_E2E_PASS`, exit **0**. Wrapper cleanup: `CLEANUP_VERIFIED_TWICE`.
- Separate post-test read-only ref absence verification: `READ_ONLY_CLEANUP_VERIFIED_TWICE`, exit **0**.
- This test *necessarily wrote immutable blobs, a commit and the disposable branch*, then removed only the disposable branch. It did **not** re-encrypt user data and did **not** erase unreachable Git objects or old branch history. Creating/deleting a branch is **not** an erasure guarantee.

## Quality gates and outstanding work

Offline frozen dependency install, `pnpm build` (Maximum Strict TypeScript + esbuild), three GitHub E2E bundle compilation, `pnpm test:fast`, `pnpm test:resource`, `pnpm test:recovery`, `pnpm test:feasibility`, `pnpm validate:metadata` and `pnpm validate:package` passed. The D74 architectural/owner approval gate remains as-is: `ownerApprovedMigrationTopology: passed`, **six other checks pending**, overall `status: blocked`.

What D75 does NOT prove:
- No streaming full source-vault re-encryption, physical second-device restoration or per-device UI cutover.
- No independent backup/restorable inventory or crash/cancel/ambiguous partial-upload recovery.
- No rejection of a stale client in the retained source branch after a migration.
- No ABA ref race prevention or transactional source quiescence.
- No installed Obsidian desktop/mobile acceptance. The synthetic fixture is much smaller than the user's <=100 MB physical test-file cap; REST part-size policy remains 8 MiB.

**Never call D75 a completed Wizard or release-ready migration.** Keep the old source branch intact, the first-release Re-encryption Wizard gate blocked and the old-device sync freeze/cutover policy explicitly undecided until the owner approves it.
