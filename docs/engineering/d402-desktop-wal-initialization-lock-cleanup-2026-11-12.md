# D402 — Preserve another owner's WAL lock during failed initialization

Date: 2026-11-12 (Asia/Bangkok). Scope: local Windows audit worktree `.worktrees/d87-owner-rekey-policy`. Release gate remains **blocked**.

## Failure mode

`acquireV4DesktopRekeyWalStorage()` creates `.exclusive.lock` using `wx+` and initializes its token, directory sync proof and recovery-directory inventory. Before D402, if any later initialization operation failed, its `catch` unconditionally closed its original handle and executed `fs.unlink(lockPath)`.

This was unsafe. An unrelated OS process can rename away the initializer's lock and create its own lock at the same pathname while the initializer awaits directory listing or fsync. When the initializer later detects unrelated recovery residue and aborts, its cleanup deletes **the other owner's lock**. That owner can then lose its exclusive writer boundary without participating in this plugin's operations.

The same-name lock may even contain identical token bytes. The pathname and token value are insufficient evidence of ownership: file identity matters.

## Windows filesystem regression tests

The D402 tests intercept the real Node `fs.readdir` at the WAL directory boundary and modify **real disposable Windows files** during a pending initializer:

1. The negative test moves the originally created `.exclusive.lock`, creates a **different inode with the same token bytes** under the original pathname, and creates unexpected interrupted recovery evidence. Construction must fail closed **without deleting the new owner's lock** or the residue. Before the fix, test task `fb0116eb-6e80-49d6-942d-a8de0bd1db31` exited **1**: `ENOENT` when the test tried to read the other owner's lock, proving the initializer had removed it.
2. The positive test leaves the original lock untouched and injects unexplained recovery residue. Construction must fail closed, remove **only its own unchanged lock** and leave the residue available for Manual Recovery. This ensures the safety fix does not turn ordinary failed initialization into an unnecessary orphan lock.

Both tests use temporary Vault-like directories with no user data or GitHub credentials. The after-fix focused task `833eb0df-3bce-4aab-9159-fa28d124d78e` completed **2/2 PASS, exit 0**, and full Desktop WAL test file `508b988f-0058-445c-aa00-104dcee02a23` completed **32/32 PASS, exit 0**.

## Small production change

In `src/lib/v4/reencryption-desktop-wal.ts`, the failed-initialization cleanup captures the original pinned lock descriptor's BigInt `stat`, closes that descriptor even if its stat fails, then checks the lock's current pathname using BigInt `lstat`. It unlinks the path **only if** it is still a regular, single-link, non-symlink file with the original nonzero `device + inode`. A changed or absent pathname is not unlinked, and incomplete WAL evidence is not erased.

The identity comparison is a best-effort observation **before** `unlink`: Node does not provide an atomic unlink-if-inode-matches operation here. A hostile actor could still replace the pathname after the final check but before unlink. The change materially narrows the previously unconditional deletion hazard; it is **not** a globally atomic OS lease or permission for automatic recovery. Never claim disk power-loss durability or restore a lost lock without evidence and user action.

## Validation

- RED: `fb0116eb-6e80-49d6-942d-a8de0bd1db31`, EXIT 1, genuine deletion of foreign lock.
- GREEN: D402 two cases `833eb0df-3bce-4aab-9159-fa28d124d78e`, 2/2; Desktop WAL suite `508b988f-0058-445c-aa00-104dcee02a23`, 32/32; both EXIT 0.
- Maximum Strict TypeScript `d4c7336b-ac1f-4d46-a21b-07eaa30284cd`, Production Build `5b6f8b85-ac13-4928-a3af-55d0c2eda79d`, GitHub E2E strict `2bb4d428-71a7-4700-99de-bfefddb94623`, three E2E bundles `1806317a-6c29-44c5-9933-8114b92e32f5`, Recovery `761655c2-4c09-4ee0-800e-bb186512f3a3`, Feasibility `bf65321e-7558-43d1-a4fd-3ba23ecbc511`, Resource `b8636e80-b6d2-44c7-88a1-5067b110c7ee`, metadata `17a07212-ca0f-464a-9486-38b019071cca` and package `459438e8-2fd7-4234-a481-33d6d79477f8` all EXIT 0.
- Live disposable GitHub, native installed Windows Obsidian, and full current-source Fast qualification are recorded in `HANDOFF-NEXT-SESSION.md` only after terminal success and double cleanup.

## Release policy

First public release remains Sync **plus** Re-encryption together. Ciphertext transport part size 8 MiB, Mobile initiation capability gated to files <=32 MiB, single physical test file <=100 MB, best-effort Manual Recovery when insufficient evidence and no default Native Helper. No GitHub Actions, no stale-lock auto reclaim, no Wizard Execute or Settings/Selector/Index Cutover. Approved GitHub integration writes are limited to disposable `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform` physical repo ID `1284153873`, new `obsidian-sync-e2e/local-*` refs with double-verified deletion. No user Vault, default branch, commit, push or merge.
