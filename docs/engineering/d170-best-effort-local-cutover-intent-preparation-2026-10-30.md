# D170 — Best-effort local cutover intent preparation (uncommitted)

Date: 2026-10-30. Status: internal pre-cutover preparation only; release gate **blocked**.

## Purpose

D166–D169 now provide guarded best-effort Backup → encrypted Blob Staging → zero-parent Destination candidate → Destination ref publication and read-only recovery. The D135 local cutover preparation previously required strict platform directory fsync and refused the Windows Node WAL environment. D170 provides a **separate, explicitly acknowledged** best-effort preparation path without claiming an atomic Settings/SecretStorage/Index transaction or allowing any device to switch branches.

`prepareV4BestEffortReencryptionLocalCutoverIntent()` requires the literal `accept-best-effort-power-loss-recovery-risk` acknowledgement, a live WAL cooperative lease, a Generation-pinned source/destination journal, and the same D165 triple filesystem checkpoint plus two AES-GCM journal authentication protocol. Beyond D165's authenticated-but-uncommitted observation, D170 requires **exactly two completed Backup and Destination ref observations**, matching original and Destination commits, a one-shot candidate preparation digest and sealed candidate receipt, matching destination tree/manifest, no unresolved upload or Git ref intents, and no WAL publication/Cutover authorizations.

Both strict `prepareV4ReencryptionLocalCutoverIntent()` and best-effort paths share the same D135 one-shot local intent writer and source/shadow index verification. The strict entrypoint still exclusively calls the caller's crash-durability check and retains its existing mutation and callback-identity guards. The best-effort path uses repeated lease + WAL authentication at all three persistence boundaries (before reading indices, after writing the independent intent, and after readback) and pins its WAL/journal methods and identities. It writes only `<index-root>-rekey-intent-<run>/intent.json` containing **prepared-uncommitted** nonsecret identities and an unkeyed checksum; the original source and shadow index bytes remain unchanged.

The writer refuses wrong Source/Backup/Destination identity, missing WAL receipts, stale or changed WAL generation, ambiguous write response, a modified checkpoint binding, malformed Secret IDs or dirty/mismatched indices. Existing intent directories are never overwritten and require Manual Recovery. No Settings, SecretStorage, active index selection, encrypted selector, GitHub ref or original passphrase is modified. Best-effort checks **do not establish power-loss durability**, and the unkeyed intent alone cannot authorize any switch or restart.

## Verification

New D170 regression tests in `tests/v4/reencryption-local-cutover-intent.test.ts` cover exact verified WAL and source/shadow bytes preserved, wrong risk token and incomplete/foreign remote WAL denial before writes, interrupted WAL checkpoint after intent (preserving unresolved evidence and refusing reuse), and a real disposable Windows encrypted WAL journal with both verified ref observations. The Windows case uses an **in-memory local index adapter**; it proves WAL fs behavior and intent logic, not physical durability or installed Obsidian restart integrity. Existing D135 strict intent tests remain green. Focused **12/12**, Full Fast, Recovery, Feasibility, Resource **11/11**, maximum strict TypeScript, production Build, GitHub E2E compile-only, validators and bounded 100,000,000-byte SHA-256 soak are local-only qualification checks.

## Next work

A complete local Cutover requires an authoritative independently stored and authenticated Selector, persistent commit receipt/transaction ordering, Settings and SecretStorage integration, Source/Shadow Index selection, Sync fencing, restart classification and Manual Recovery UX for every interrupted write. Before the first public release, verify actual installed Obsidian Desktop and Mobile and disposable GitHub network migration with the owner-approved branch topology. Do not infer Cutover authority from a prepared-uncommitted intent or best-effort WAL observation. Keep the Wizard Preview-only and release gate `blocked`.
