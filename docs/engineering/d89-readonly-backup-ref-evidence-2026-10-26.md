# D89 — Same-repository backup ref: read-only pinned-pointer evidence

Date: 2026-10-26 (Asia/Bangkok). Base clean/pushed D88 commit `820b3e1d375a13b203d5b481139c0713b4bc7523`. Continued in isolated `.worktrees/d87-owner-rekey-policy`; no new GitHub branch, credentialed mutation, vault contents, or release.

## Why this matters

Owner's approved B backup topology is a separate branch **within the original physical GitHub repository**. A proposed backup branch name, a GitHub create-ref response, or a Git ref merely pointing to the expected commit is **not** a full backup integrity, creation/provenance, or restore proof. Malformed or changing GitHub API replies must not be promoted to permission to migrate or cut over.

## Read-only implementation

`src/lib/v4/reencryption-backup-ref-readback.ts` introduces `inspectV4SameRepositoryBackupRef`. It accepts an existing D87 proposal (still blocked), an **externally authenticated** exact source tree SHA, and two separately branch-scoped read-only GitHub API clients (source and backup). It:

1. Validates approved blocked plan shape, full lower-case source commit/tree SHA, same owner/repo and distinct source/backup/orphan ref coordinates. Rejects a forged backup branch name or mismatched physical repository ID.
2. Reads **both GitHub numeric physical repository identities** before and after the inspection, requiring the same owner/repo and approved numeric ID.
3. Observes both exact `refs/heads/*` values before and after immutable commit inspection, requiring a `commit` object pointing to the **same pinned source commit**. Missing ref, redirected branch, stale tip, symbolic/non-commit object and changed ref fail closed.
4. Loads immutable source and backup commit descriptors through both clients, requiring identical full commit SHA, the previously authenticated exact source tree SHA and parent SHAs.
5. Returns frozen redacted `integrityScope:"same-repository-backup-ref-pointer-only"`, `refAndCommitPointersMatch:true` but **`backupCreationProven:false`, `backupContentsReadbackVerified:false`, `independentStorageVerified:false`, `permissionToPublish:false`, `cutoverAuthorized:false`, `oldBranchDeletionAuthorized:false`**. No GitHub write/delete API is used or exposed to this inspector.

**Security limitation:** Sampling ref values twice is **not an atomic CAS or a guarantee against ABA changes between samples**. The expected source tree SHA MUST come from separately authenticated D69/D70 source verification. A matching commit pointer does not prove that all reachable blobs can be read and decrypted, or that this Wizard created the backup ref. It provides only one preliminary read-only observation. The actual backup writer must securely claim a unique create-only ref, reconcile unknown outcomes and preserve a durable provenance receipt. Verified content readback and a separately isolated restore are still required before `safePreviewAndBackup` may pass.

## GitHub transport hardening

Previously `GitHubClient.getGitRef()` fabricated `ref` from local settings and `type:"commit"` when the GitHub response omitted those fields. An apparent good backup ref could therefore have been an untrusted/malformed response masked by local defaults. Now it rejects missing/malformed `ref`, `object.sha` or `object.type` instead, without changing normal valid GitHub GET behavior. Other code must still validate the actual full Git SHA and expected branch/type for its operation. The 404-vs-other-error behavior in `getGitRefOrNull()` remains unchanged.

## RED/GREEN validation

- New `tests/v4/reencryption-backup-ref-readback.test.ts`: **10/10** behavioral cases for good pointer observation, mismatched physical ID/name, wrong/absent/non-commit refs, mid-check ref changes, mismatched immutable commits/trees/ancestry, identity drift, abort during reads, read failure, forged plan, and backup-proof non-authorization.
- New malformed-ref regression in `tests/v4/github-transport.test.ts` failed **before the fix**, passed **after**, validating missing `ref`, object SHA/type, empty ref and null response; valid response still parsed unchanged.
- `pnpm test:fast` **769/769**, `pnpm test:recovery` **79/79**, `pnpm test:resource` **11/11**, `pnpm test:feasibility` **136/136**, `pnpm build`, `pnpm typecheck:max-strict`, `pnpm test:github-e2e:compile` (3 bundles), `pnpm validate:metadata`, `pnpm validate:package` all **exit 0**. No credentialed GitHub E2E, actual Obsidian runtime, device migration or power-loss simulation was performed in D89.

## Still blocking production

The tracked `docs/release-gates/reencryption-wizard.json` remains **blocked**, `safePreviewAndBackup:pending`; this work alone must NEVER mark it passed. A real backup-ref writer and copy ownership proof, full remote object and plaintext readback/isolated restore, old/offline client fence, local-edit quiescence, robust Windows Node.js WAL durability (D86 directory fsync `EPERM`), native two-device and mobile acceptance all remain unresolved. Preserve the source and backup until the user explicitly requests deletion. No Native Helper, GitHub Actions, Force Push/Pull, or automatic cleanup.
