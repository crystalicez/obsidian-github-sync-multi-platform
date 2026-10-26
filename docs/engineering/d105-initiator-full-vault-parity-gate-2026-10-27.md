# Stage D105 — Initiating-device exact local-vault parity before Destination publication

Date: 2026-10-27. Status: **internal guarded backend implemented; NOT production/release qualified**.

## Binding owner decisions
D90/D91 require three distinct roles in the SAME physical repository: old source branch continues Sync independently; frozen old-key Backup ref pins the exact source SHA; new encrypted orphan destination has a zero-parent root commit and fresh branch-scoped key. Other devices remain on old Source indefinitely unless manually reconfigured. No GitHub Actions, automatic fleet freeze, branch merge/delete, Native Helper selection, or waiver of Windows crash durability.

## Finding
D100 used an externally provided `assertInitiatingVaultUnchanged` callback at important boundaries. A caller could satisfy this with a trivial async function even while the initiating-device Vault contained unsynced local edits or a note changed without altering file size/mtime. That would risk switching credentials while local content was not represented by the pinned source fork.

## Actual D105 implementation
New `src/lib/v4/reencryption-initiator-parity.ts` provides `verifyV4ReencryptionInitiatorLocalParity`. This is READ-ONLY and accepts **authenticated exact source records**, pinned commit/source summary and a trusted per-device physical IO reader. It:
- Validates source SHA, every record's SHA-256/size/path, duplicates and case-insensitive Unicode path collisions, and exact source count/byte totals before any physical IO.
- At start, during reads and end, invokes a caller-supplied exclusive initiating-device lease, Sync/Recovery/pending-edit fence, captured source connection/scope identity guard and explicit open-editor inventory; **refuses even a saved source note open in an editor** because unsaved buffers and reopen races have not been proven safe.
- Lists ALL physically present files in the captured Sync scope; rejects added/deleted/renamed/unexpected files, invalid metadata, size drift and ambiguous case-folded names.
- Streams and hashes every local file using the existing bounded V4 incremental SHA-256 (maximum 8 MiB per chunk), never logging or returning note contents. Comparing every byte by hash detects same-size/same-mtime user edits. Rechecks the final physical file listing/mtime and all fences to notice edits during the scan; remote mtimes are NOT expected to equal the initiating device's local clock.
- Returns a minimal immutable report with `initiatorLocalCutoverAuthorized:false`. This is **not** an OS file-system snapshot, an editor write lock, or a capability token; external processes could still mutate after the last scan. Future local cutover must use a real IO/event fence and redo parity at the final transaction boundary.

**D100 integration:** `publishV4ThreeBranchDestinationAfterBackup` now **requires** D105 initiating-vault parity input and checks exact pinned source/verified old-key backup totals before its first remote ref mutation. Its existing guard repeats a whole-vault SHA-256 parity read at every important mutation boundary (including after the durable ref intent). D102 journal-bound publisher forwards the same input rather than bypassing the guard. A failed or changed local file forbids `createGitRef`. This is intentionally expensive; optimizing via a genuine atomic filesystem snapshot or lock requires a separately reviewed architecture.

## Tests
- New `tests/v4/reencryption-initiator-parity.test.ts` covers ordinary and empty vaults, missing/extra files, mismatched sizes, content edits preserving byte size and mtime, Unicode case collisions, open editor, active Sync, changed settings, lost lease, mid-scan mtime edit, forged remote totals and cancellation.
- Expanded D100/D102 in-memory GitHub lifecycle tests show that changed initiating-device bytes or a new unsynced file appearing **after publication intent** prevents Destination branch ref creation; valid unchanged fake initiator bytes still permit one simulated create + complete remote decrypt/readback (never local cutover).
- Local full qualification: `pnpm test:fast` **868/868 PASS**, `pnpm test:recovery` **79/79**, `pnpm test:resource` **11/11**, `pnpm test:feasibility` **136/136**, Maximum Strict TypeScript, build, E2E compile (three bundles), validate package/metadata all PASS.
- No credentialed real GitHub run, native installed Obsidian two-device migration, real live Vault read/write, or physical power-loss experiment in D105. Mock readers/leases in tests do not prove an installed Obsidian IO lock.

## Hard remaining release blockers
1. Wire D105's physical reader to an audited live Obsidian desktop filesystem inventory and editor/queue/change fence. Desktop Obsidian's cached `vault.getFiles()` **alone is not a physical file snapshot**. Mobile must have separately qualified read-only behavior. No module currently provides a trustworthy process-wide filesystem freeze for concurrent external edits.
2. D86 Node-only Windows directory `fsync` still returns `EPERM`, so crash/power-loss durable migration-ref WAL is **not proven**. D102's WAL callback cannot be treated as proof merely because a test mock returns successfully. Do not weaken this contract.
3. Persist destination metadata/tree/commit and fresh key material in a recoverable, secret-safe workflow; qualify actual OS durable local index/settings/passphrase transaction, safe recovery of unsynced notes and initiating-device-only switch. Other clients keep syncing old Source.
4. Disposable GitHub **three-ref** real E2E with pinned numeric test repo ID `GITHUB_E2E_EXPECTED_REPO_ID`, independent installed Windows two-device and macOS/Linux/mobile validation, interruption/restore/rollback, performance and UI acceptance, 100 MB physical test-file cap. GitHub Actions prohibited.

The first-release `docs/release-gates/reencryption-wizard.json` remains `status:"blocked"`; user-facing Wizard remains preview-only.
