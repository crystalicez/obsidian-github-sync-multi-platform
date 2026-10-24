# D72 — Physical GitHub repository identity guard for pre-rekey source verification

Date: 2026-10-24 (Asia/Bangkok). Isolated audit branch from D71 `f4ada99`.

## Finding

D70–D71 cryptographically authenticated remote V4 metadata, exact Git commit/tree/blob identity, encrypted plaintext and pre/post branch HEAD. **However, the caller-provided GitHubClient was not bound to the intended *physical* GitHub repository.** A wrong repository with a matching or copied `repoId` and a similarly named branch could be read successfully, and a repository rename/transfer or client target swap during verification would not necessarily change the commit SHA. V4's `repoId` is an owner/repo/branch string used for cryptographic derivation, not GitHub's immutable numeric repository ID.

## Change: read-only, fail-closed identity proof

- `GitHubClient.getRepositoryIdentity(): Promise<{id,fullName}>` performs an ordinary authenticated GET on the **client's currently configured** `/repos/<owner>/<repo>` endpoint. It rejects non-200 HTTP results, missing/malformed `id`, nonpositive/unsafe numeric IDs, unsafe owner/repository coordinates, or malformed `full_name`. No extra write scope, mutation API or GitHub Actions are involved.
- `verifyGitHubReencryptionSource` requires this method on the selected GitHub read surface. It verifies the returned `fullName` matches the expected `owner/repo` coordinates from `repoId` case-insensitively (GitHub's repository names are case-insensitive) and that its numeric ID is valid **before the first Git ref/object read**.
- After all live encrypted objects pass exact-commit tree/blob SHA, AES-GCM, plaintext SHA-256 and mutable HEAD checks, it **re-reads** physical repository identity; a changed numeric GitHub repo ID or name fails verification. This new probe is independent of the pre/post mutable Git ref checks and is deliberately not cached across the operation.
- No change is made to normal Sync, remote layout, cryptographic KDF defaults, part size, user settings, plugin UI or existing release blocker.

## Red-green evidence

- RED: two new `github-repository-identity.test.ts` tests initially failed because the API method was absent. GREEN: **2/2** exercises the exact GET URL/method, numeric ID, canonical full name, bad/missing/wrong data and HTTP errors.
- `reencryption-trusted-loader.test.ts` gains a real-world physical-repository mock (`Owner/Repo` mixed-case name and stable numeric ID) and two fail-closed cases for wrong/malformed repo *before any Git object read* and identity switching *during* encrypted object reads. The D70/D71 regression cases remain in place; focused loader **12/12**.
- Offline frozen install, maximum strict TypeScript `pnpm build`, full `pnpm test:fast`, `pnpm test:resource`, `pnpm test:recovery`, `pnpm test:feasibility`, `pnpm test:github-e2e:compile` (3 bundles), `pnpm validate:metadata`, `pnpm validate:package` all PASS.

## Trust boundaries still open

- The repository ID probe assumes the existing `GitHubClient` is a **trusted instance** configured for the user's authorized account and destination. It does not independently authenticate a maliciously supplied callback, replace an authorization prompt, or compare to a repository ID persisted from an earlier owner-approved connection.
- Two identity reads plus multiple ref observations **do not prevent an ABA change-and-revert race** or a later edit after verification; eventual cutover requires a coherent source snapshot/quiescence and a write-time fencing architecture.
- No native live GitHub read or device-to-device migration was executed in D72. The tool only augments the read-only preflight bridge; full backup, WAL recovery, encrypted destination creation, stale-device blocking and release acceptance remain missing.
- **D66 Re-encryption Wizard release gate stays `blocked`**, all seven checks pending. The owner still must choose migration topology **A** (new destination with independent history, recommended) vs **B** (in-place), including A's same-repo branch vs separate private repository details, before any mutating migration code.
