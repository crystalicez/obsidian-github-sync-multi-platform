# D397: verify a real GitHub Backup before an installed WAL handoff

Date: 2026-11-11. All files are in the inherited D87 audit worktree. **Release remains blocked.**

## The missing installed evidence

D396 had two independent proofs. Node E2E could create and authenticate a frozen old-key Backup and new-key orphan Destination. Installed Windows Obsidian could also bind a pinned GitHub Source manifest to actual physical-Vault parity, persist a pending-only encrypted Backup intent under its runtime-owned lease, and re-open that WAL after a real process restart. It had not recorded a **verified frozen Backup** in the installed WAL, so it could not demonstrate that transition toward Staging in a real Obsidian process.

D397 connects those two test stages without giving an installed Obsidian process a GitHub credential. It is a **test-only parent-authenticated evidence handoff**, not production GitHub authentication.

## Evidence flow

1. The approved disposable GitHub E2E parent writes an encrypted Source to a new `obsidian-sync-e2e/local-*` branch. A fresh GitHub client independently authenticates its immutable commit with the original key and obtains an exact file, SHA-256, and plaintext-byte inventory.
2. The parent preflights an independently derived, absent `obsidian-sync-e2e/local-backup-*` branch on approved numeric repository ID `1284153873`. It issues **one create-only Backup ref request**. It then independently reads and decrypts all Backup contents with the original key, checking the exact frozen Source commit, tree, file count, and byte count. If GitHub's immediate ref read is uncertain, the parent can accept only an independently authenticated full Backup readback. It never retries the create POST. The transferred claim explicitly says `creationProven:false`.
3. The parent writes only a bounded, token-free JSON evidence manifest containing Source inventory, Backup identity, old-key readback result, physical repository ID, and blocked authorization flags. It passes the SHA-256 of those exact bytes as a separate argument. The child checks that raw-byte digest and the deterministic derived Backup and Destination branch identities **before creating any installed Vault**. A same-size tamper of either Source tree SHA or verified Backup branch is rejected before Obsidian startup.
4. A fresh disposable installed Windows Obsidian process starts with **no GitHub token**. Its real `V4PluginRuntime` arms the persisted Sync fence, uses a live initiating-owner lease to verify the physical Vault against the parent-authenticated Source inventory, and opens the installed native desktop WAL writer.
5. The test-only probe, using the actual runtime-provided WAL adapter, begins the journal, persists a Backup intent at generation 2, records the parent-verified Backup readback at generation 3, and persists the one-shot Staging handoff at generation 4. Its authenticated WAL snapshot has **one exact Backup receipt, no unresolved intents, no staged Git blobs, and all publication and Cutover flags false**.
6. After a true Obsidian process restart, a new read-only adapter independently re-authenticates both physical encrypted WAL slots at generation 4, requires the verified Backup record and Staging handoff, and observes persisted Sync fencing. It does not resume Sync, retry GitHub writes, or change Settings/Selector/Index.
7. The parent and outer wrapper separately verify the disposable Backup and Source branches are absent twice after cleanup. All temporary installed Obsidian processes, profiles, and Vaults are removed.

The installed child never authenticates GitHub itself, never receives an old passphrase or remote credential, and never sends a GitHub mutation. Its encrypted WAL key is the fixed D377 test-only fixture, **not a release key**.

## Failure and negative tests

- Initial new-mode Live E2E task `0d57e63e-46f4-4537-805b-d0872cead557` exited 1 because the new manifest still met the old Destination naming rule. Both disposable refs were cleaned twice. D397 now checks deterministic derived Source, Backup, and Destination names independently.
- Second attempt `4034cfed-7206-4d77-9651-92633ba35038` exited 1 because an immediate GitHub Backup ref observation was uncertain after a single successful create-only POST. Both disposable refs were cleaned twice. D397 does **not** relax production readback rules or retry GitHub creation. It accepts only an independent, full old-key cryptographic Backup readback in the test parent and reports `creationProven:false`.
- Positive Live E2E `92383692-248b-4eb6-8d11-2ec978442918` exited **0**. One focused GitHub E2E passed. All three installed Obsidian modes passed: `backup`, `backup-tamper` (one-byte same-size physical Source drift rejected with WAL hashes unchanged), and `backup-revoke` (the original lease revoked after handoff, denying new WAL writes and checkpoints). Each mode performed a real Obsidian process restart, independently authenticated the generation-4 WAL, and removed its temporary Vault/profile.
- In the final Live run, pinned encrypted Source commit was `e3a7ed2b47fa8e36aff2f7a0c05315c9d8ed0d7a`. Disposable Source `obsidian-sync-e2e/local-65046b2929db-d24-installed-source-backup-handoff-encrypted-9eab5c43a258` and frozen Backup `obsidian-sync-e2e/local-backup-99c6d0e3f209760046d0be9a5d08955e` both ended `CLEANUP_VERIFIED_TWICE` on repository ID `1284153873`, followed by `LIVE_E2E_PASS`.
- E2E TypeScript strict check `d91e72f4-aa67-485b-967c-b93082ce1772`, three-bundle E2E compile `6f2d0ef4-6723-4a3b-a191-5206caa8fb93`, and standalone runner syntax `c7d2c2ba-9f47-49dd-aace-806f7d946923` exited 0. The final full Fast source-fingerprinted qualification is recorded separately in `HANDOFF-NEXT-SESSION.md` once terminal evidence exists.

## Limits and release decision

D397 does **not** exercise the native installed Obsidian process issuing the GitHub Backup POST. It does **not** stage new-key Git blobs or publish a Destination branch from that same installed runtime. The parent-provided token-free evidence digest is not a signed remote attestation and must never grant production publication authority.

The missing release gates remain the integrated installed-owner Source → Backup → Staging → Destination transaction, restart-safe Settings/Selector/Index Cutover, cross-device stale-client recovery, physical Android/iOS acceptance, and disclosure of old-key Git history. Physical Windows power-loss durability is not proven; best-effort Manual Recovery remains the approved fallback. Keep `docs/release-gates/reencryption-wizard.json` at `blocked`. First release still requires Sync and Re-encryption together; 8 MiB ciphertext parts and capability-gated Mobile initiation <=32 MiB remain unchanged. No production Vault, default branch, GitHub Actions, commit, push, or merge was modified in this stage.
