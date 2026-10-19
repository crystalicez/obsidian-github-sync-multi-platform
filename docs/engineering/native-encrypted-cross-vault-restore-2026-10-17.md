# Native encrypted cross-vault restore acceptance — 2026-10-17

## Outcome

**PASSED** on real Windows Obsidian Desktop 1.14.4 in **two independent isolated Electron profiles/vaults**, using the maintainer-authorized disposable GitHub repository. Tested code commit **`74fdaaea6c5c3cc7dea56018eec8750ffe3fc8d5`** from a detached clean checkout. Runner:

```powershell
$env:GITHUB_E2E_ENV_FILE = 'E:\Coding\obsidian-github-sync-multi-platform-forked\.env.github-e2e'
$env:GITHUB_E2E_EXPECTED_REPO_ID = '1284153873'
$env:GITHUB_E2E_SOURCE_REPO_ID = '1282135059'
node scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --verify-peer
```

**Important:** the live command creates, mutates and deletes a random disposable test branch. The test repository and pinned numeric ID are verified before mutation, and this acceptance does **not** change the source repo's main/default branch.

The runner returned:

```text
status=PASS
mode=encrypted
remoteHeadChanged=true
remoteEncryptionVerified=true
peerRestored=true
screenshotCaptured=true
uiExceptions=0
cleanup=absent-verified
exit_code=0
```

## What was tested

1. A read-only authenticated GitHub preflight confirmed the target `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform` with repository ID **1284153873**, default branch `main` and a newly generated branch `obsidian-sync-e2e/local-74fdaaea6c5c-3f7887f976e5aac1` **absent before writes**. Source repo numeric ID **1282135059** remained excluded.
2. **Vault A** was created exclusively in `<repo>/.tmp/obsidian-live-github-e2e/<random-hex>/vault` with its own Obsidian user-data profile. The **built production plugin** loaded in real Electron. The test configured the authorized repo/branch and a fresh random 32-byte encrypted passphrase via the plugin settings API, disabled auto/scheduled sync, initialized a fresh encrypted remote branch, edited a synthetic note through Obsidian's vault API and clicked **Sync Center → Sync now** in the real UI.
3. Authenticated GitHub API checks verified that the resulting HEAD SHA advanced. Its tree had V4 metadata and opaque encrypted `.enc` objects, no `UI-smoke.md` plaintext Git tree path, `mode=encrypted`, `pathLayout=opaque-stable-v1`, `AES-GCM`, a valid `OGS4` ciphertext header, and no plaintext sample content in the encrypted blob.
4. **Vault B** was freshly created in a **separate** project-local vault and Electron user-data profile. It had no original note, index or remote settings. Before any credential setting, the second CDP session asserted its *exact real vault path*. It loaded the same built plugin, received only the authorized test repo/branch and the ephemeral passphrase, and ran a **Force Pull solely inside the blank disposable Vault B**. The plugin produced `lifecycle=success`.
5. Vault B then independently read `UI-smoke.md` via real Obsidian's `app.vault.read` and compared the **exact text** (not just a file hash or filename): `# Synthetic remote UI E2E`, blank line, `Second revision from Obsidian.`, trailing newline. The note was opened in its actual Obsidian editor. The runner required the expected content to be visible in the window before capturing a valid PNG screenshot.
6. The GitHub branch HEAD was queried **again after Vault B's Pull** and was exactly unchanged from the preceding commit, demonstrating that the restore did not silently write remote data.
7. The runner terminated only the two isolated Obsidian processes, deleted the randomized local run folder with a scoped bounded Windows retry, then deleted the one random remote branch with target-ID/default-branch safety guards and verified its absence. A **second independent authenticated API probe** after the runner exited proved the branch absent, target repo ID unchanged and default branch still `main`. Windows process/filesystem checks found **zero remaining test Obsidian processes and no synthetic vault/profile folder**.

[**Real screenshot — recovered encrypted note open in independent Vault B**](ui-real-screenshots-2026-10-17/14-live-encrypted-second-vault-restored.png). This screenshot was opened and visually reviewed; the editor shows the test note and second revision, with `GH Sync: Success` in Obsidian status bar. It contains no credential or passphrase.

## Code and regression gates

- New `scripts/obsidian-live-ui-peer.mjs` starts and controls a distinct Obsidian Electron instance, enforces the exact random synthetic vault identity before configuring any credential, restores the encrypted branch into an initially empty vault, asserts the exact restored note content and visible editor, captures the real PNG, and shuts down only its own process.
- `--verify-peer` is **opt-in and requires `--mode=encrypted`**; it does not attempt device recovery for plaintext mode or an arbitrary vault. The original `--mode=plaintext` and one-device `--mode=encrypted` workflows remain available.
- New `tests/v4/obsidian-live-ui-peer.test.mjs` rejects missing/failed restore, incorrect filename and altered decrypted content; new CLI regression verifies invalid peer-mode selection cannot reach network. Focused peer/harness/encrypted/cleanup suite **12/12** passed from the exact clean code SHA.
- The code was compiled successfully in the detached worktree. The full Fast, Repeat, Recovery, Resource, Feasibility, Metadata/Package and GitHub E2E compile-only gates were run from that exact SHA.

**Limitations:** This proves encrypted two-vault recovery on **one Windows desktop host with two separate Obsidian profiles**, not physical Android/iOS synchronization. The second vault invokes the runtime's Force Pull instead of interacting with the pointer-only Force confirmation slider; configured Force keyboard/screen-reader accessibility remains unresolved. Repository credentials and passphrase were installed by the isolated test runner, **not typed into the full native Settings UI**. No real personal vault, shared credentials outside the test fixture, merge, release or source default-branch mutation is claimed.

## Evidence hygiene

No token or passphrase was printed or committed. The `.env.github-e2e` remains ignored/protected; required pinned IDs were supplied as process-only environment overrides. The tested source worktree was detached/clean and excluded the primary workspace's unrelated unstaged `tests/v4/github-transport.test.ts` WIP.
