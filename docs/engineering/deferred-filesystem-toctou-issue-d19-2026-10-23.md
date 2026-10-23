# Archived GitHub Issue #9 Research — Desktop filesystem TOCTOU / path-swap races

**2026-10-23. STATUS: FILED and verified — [Issue #9](https://github.com/crystalicez/obsidian-github-sync-multi-platform/issues/9), OPEN but DEFERRED.** On creation attempt in `crystalicez/obsidian-github-sync-multi-platform`, the GitHub API returned **HTTP 410**: `Issues has been disabled in this repository.` This is a historical failure; Issue #9 now exists and has been verified. **D20 update:** the user has explicitly approved enabling repository Issues, but the connected tools cannot change that repository setting. The feature was enabled by the user; no additional setup is required. The user enabled Issues and the GitHub connector created and verified Issue #9. This document is now archived provenance, not a request to create or implement another issue.

Actual issue title:
`[Deferred / Node.js-first] Desktop filesystem TOCTOU/path-swap races — D12–D18 findings and native research`

Canonical deferred ticket: [#9](https://github.com/crystalicez/obsidian-github-sync-multi-platform/issues/9). The research text below is retained as an archived, linked source; creating a duplicate issue is unnecessary.

---

## Decision — Node.js-first; **do not work on this issue unless user explicitly asks**

User decision (2026-10-23):

- Keep **Node.js + Obsidian API** as the primary production implementation, including active staging/backup/WAL, SHA-256 verification, bounded IO, recovery proofs, and editor protections.
- Native Helper work D16–D18 is **research only**. Do **not** integrate, compile into the plugin, sign/ship native binaries, silently enable file sharing locks, select IPC-vs-N-API architecture, or change the OS platform support contract.
- Defer this filesystem race-condition issue and its native research **until the user explicitly asks to revisit the issue**. Don't automatically resume because the issue is open or a new session begins. No GitHub Actions; no release/master changes.
- Preserve honest security claims: the current Node.js adapter **does not offer a proven guarantee against deliberately concurrent, OS-level pathname/junction swaps**. Deferral does not establish that hostile concurrent filesystem writes are safe or that every release gate has been met. Continue unrelated quality work only when separately directed.

## Original underlying risk in the active plugin

The Desktop adapter (`src/lib/v4/platform-io.ts`) verifies vault containment and expected original/staged content, then uses pathname-based synchronous `fsSync.renameSync` and `fsSync.rmSync` for staged commits and recovery. D12 and D15 narrowed attacks enabled by asynchronous `await` gaps by running a synchronous guard immediately before a rename/deletion without yielding JavaScript.

**Residual:** `lstatSync` + `renameSync`/`rmSync` are still separate OS syscalls. An external process can install a junction/symlink or otherwise mutate directory entries between them (TOCTOU). This is not the same as a known unconditional outside-vault write in current D15 code; it is a reproducible class of race requiring a stronger OS contract for a complete guarantee.

Policies that remain in force: Recovery A (automated only with sufficient evidence; otherwise preserve/manual review), in-flight settings B (pin connection/encryption settings for a running sync), open-note policy 1 (defer while editor unsafe), network-drive B (Desktop best-effort with persistent warning), Mobile best-effort.

## Concrete findings and proofs — D12 through D18

| Stage | Evidence | Correct interpretation |
| --- | --- | --- |
| **D12** | Real Windows last-moment junction swaps during staged commit/rollback produced an outside-vault mutation before synchronous path rechecks were added. Physical fail-first RED then guarded GREEN. | JS `await` vulnerability fixed at demonstrated boundaries; separate OS syscall TOCTOU remains. |
| **D15** | Two additional real Windows asynchronous parent-junction swaps before cleanup of original backup / rollback residue reproduced risks; guards added synchronous recheck + `rmSync` with no intervening JS `await`. Containment regression **14/14**, Fast **503/503**, Recovery **79/79**, Windows Obsidian real encrypted two-instance small E2E passed. | Improved active Node code, not an OS-handle atomic guarantee. |
| **D16** | Test-only Windows P/Invoke `NtCreateFile` relative to opened parent, no-follow reparse checks, `SetFileInformationByHandle` delete by already held file handle. Windows NT `10.0.26300` x64 local filesystem real junction/symlink **40/40**. Windows refused renaming held parent (`EPERM`); changing leaf filename to external symlink did not redirect held-handle deletion. | Feasible narrow native proof only; no production integration, signed artifact, cross-platform/network qualification. |
| **D17** | Test-only native handle-relative `NtSetInformationFile(FileRenameInformation=10)` for `original→backup→target`; proof-gated rollback from four real process kill/restart points (after native backup, publish, park, restore rename returns). **180/180** 18 scenarios ×10 on local Windows. Test-only SHA WAL intent fsync. | No in-syscall power cut or file/directory metadata durability; no proof of product WAL correctness. |
| **D18** | Critical fail-first D17 PoC bug: external actor renames already-open source; the native pinned handle then moves the **user-renamed file** into backup, even with identical SHA. Test-only mitigation binds full 128-bit `FileIdInfo` + volume serial to fsynced synthetic WAL and compares current logical name with pinned handle. Same-hash different-object and pre-rename swaps now refuse. **But** a deliberate swap *after* File ID/name comparison and *before* native rename still relocates the wrong logical file under permissive share mode (forced gap **10/10 unsafe**). `FILE_SHARE_READ` strict-sharing test mode blocks external rename/write (`EBUSY`), including at forced post-proof gap, but is itself blocked by a previously open writable editor handle. **260 total observations = 250 protective + 10 deliberately unsafe**, not 260 secure passes. | File-ID proof alone is NOT atomic. Strict OS locks trade safety for editor / application compatibility; no user authorization to ship them. |

Both D16 and D17/D18 native helpers are C# P/Invoke **research source** compiled explicitly via manually invoked test scripts into ignored `.tmp` and deleted on completion. No native DLL/addon/executable is tracked or included in release. The latest tested actual Windows Obsidian encrypted integration remains D14 1,000-note lifecycle on prior code and D15 small dual-instance journey; none of these runs used a native helper.

## Reports and test entrypoints retained in audit branch

Audit branch: `audit/2026-10-21-staged-production-integration`; D18 validated state `27a46f512d9123b56dfca5b26ca7c37aa7d99a4c` ([historical commit](https://github.com/crystalicez/obsidian-github-sync-multi-platform/commit/27a46f512d9123b56dfca5b26ca7c37aa7d99a4c)).

- `docs/engineering/desktop-late-path-swap-d12-2026-10-23.md`
- `docs/engineering/desktop-late-cleanup-d15-2026-10-23.md`
- `docs/engineering/windows-handle-containment-poc-d16-2026-10-23.md`
- `docs/engineering/windows-handle-rename-rollback-poc-d17-2026-10-23.md`
- `docs/engineering/windows-handle-file-id-share-race-d18-2026-10-23.md`
- `poc/windows-handle-no-follow/HandleProbe.cs` and `RenameProbe.cs`
- Manually invoked research-only `node scripts/test-windows-native-handle-poc.mjs --repeat=10` and `node scripts/test-windows-native-rename-poc.mjs --repeat=10`. The D18 result intentionally says `POC_COMPLETE_WITH_PROVEN_RESIDUAL_RACE`.
- `HANDOFF-NEXT-SESSION.md` stores context and authorization boundaries.

## What remains unqualified

- No atomic guarantee that a path still refers to the expected source at the exact mutation syscall; a concurrently renamed opened file may cause undesirable mutation despite matching content hashes.
- No physical power-loss or in-syscall crash/directory fsync/WAL receipt durability acceptance. D11 process-kill tests and D17 helper-kill tests are narrower.
- No cross-version Windows, real mapped/UNC SMB/NFS/cloud volume, macOS/Linux/iOS/Android native handle and share-lock support matrix. Note Windows SMB2 native protocol may not honor a nonzero `RootDirectory` in rename messages.
- No proof that strict file-share locking coexists with Obsidian/editor/autosave, antivirus, oplocks, mapped writable views, hardlinks and other live apps.
- No signed/secure native distribution/upgrade strategy, supported packaging ABI or mobile strategy. Production remote protocol migration C2 and per-line conflict merge UI are other independent workstreams.

## Options to discuss **only if user reopens issue**

1. Keep Node.js primary and continue ordinary safe product engineering with explicit documented OS-level residual race, not a promise of adversarial atomic containment.
2. Evaluate strict Windows share mode with a newly approved **defer/retry/preserve all WAL and user data** behavior for external writable handles. This may reject or stall sync when a note is edited elsewhere and must be UX-tested; do not infer approval from the preexisting open-note editor rule.
3. Consider a native helper architecture only after user authorizes a specific implementation and scope (signed subprocess/IPC vs N-API addon); assess cross-platform availability and updated attack surface.
4. If any new implementation is approved, independently prove file identity at mutation time, recovery/WAL receipts and real disk durability, adversarial directory moves, actual network shares, plus platform matrix before promotion.

## Parked issue handling rule

**Do not automatically pick up, implement, close, or ship [Issue #9](https://github.com/crystalicez/obsidian-github-sync-multi-platform/issues/9).** Only resume after the user specifically says to review this deferred race-condition issue. The GitHub issue has been created and verified; this document is retained for provenance.

No GitHub Actions, `master` modifications, release, personal vault or >100MB physical file are part of this deferred ticket.
