# D129 — Node-only Windows Vault-wide writer fence: isolated real-process falsification

Date: 2026-10-28. **Research-only; no production fence, no Native OS Helper and no migration cutover. Re-encryption release remains BLOCKED.**

## Exact question and safety boundary

Can a migration owner, using only Node.js `fs.open()` and a cooperative `wx+` sentinel, **guarantee** that all other processes cannot change an Obsidian Vault during the source-parity → Git destination publication → initiating-device cutover window?

**Empirical answer on the tested Windows x64 / Node v24.22.1 host: NO.** This experiment only tests these specific Node mechanisms; it does not establish that no other Windows architecture could ever implement a genuine fence. In particular, Windows `CreateFile` supports native sharing modes that are not equivalent to Node `fs.open('r')` or `fs.open('wx+')` file creation.

This is a reproducible non-production experiment in `tests/recovery/windows-vault-write-fence-feasibility.test.mjs`. Each run creates its own disposable `.tmp/d129-*` subtree inside this repo and deletes that exact subtree in `finally`; it never opens a user Vault or accesses network/GitHub. Each test uses an **independent child Node process** to perform real filesystem I/O, not a mocked vault adapter or unawaited watcher callback. On non-Windows platforms, the two Windows-specific assertions explicitly SKIP.

## Verified results: child can write despite owner-held handles

### Case 1 — held note descriptor + existing sentinel + child process

1. Create a disposable vault with `notes/pinned.md` containing `note-version-0001`.
2. Parent retains an actual OS file descriptor returned by `fs.open(note,'r')` and keeps `fs.open('.migration-sentinel.lock','wx+')` open.
3. A **cooperating** child attempting the same `wx+` sentinel acquisition is rejected with `EEXIST`, as expected. This demonstrates **cooperative reservation only**.
4. A **non-cooperating** child independently uses ordinary Node `fs.writeFileSync()` to overwrite the held note with `note-version-0002` (same byte count), restores its file timestamps, creates a new note, and renames it from `untracked.tmp` to `unsaved-new.md`, **all while the parent still holds both descriptors**.
5. Assertions confirm the child's exit status is zero, the original note contents changed, the file length is unchanged, the previously nonexistent note now exists under its renamed path, and the sentinel bytes remain intact. A name-reservation lock by itself did not prevent the external changes.

### Case 2 — post-verification same-size edit

1. Parent reads and verifies a 64-byte note before migration (point-in-time observation) while retaining its `fs.open('r')` descriptor.
2. **After that scan**, an independent child overwrites all 64 bytes and calls `utimesSync()` to restore the previously observed timestamps.
3. Parent re-reads and confirms the note changed while preserving exact byte count. On this test host, the observed mtime delta after explicit restoration ranged from approximately **0.42 to 0.73 ms** across two runs, emphasizing that metadata heuristics cannot substitute for immutable content evidence or a real write fence. Timestamp precision may vary by Windows volume; the test deliberately does not assert exact mtime equality.
4. Even D123's double SHA-256 read cannot stop a later external writer; it only detects changes occurring **during its observation window**. D124's source pinning and D125's Git candidate identity guards similarly do not prevent a write after their last read.

## What this does and does not prove

- **Proven:** `fs.open('r')` handles and `wx+` cooperative sentinel do not exclude independent ordinary Windows Node writers on this real host. Existing-note content mutation and previously unknown file creation/rename remained possible while the parent process retained its handles.
- **Not proven:** Windows APIs in general cannot fence a Vault; filesystem watcher callbacks are a synchronous, preventative barrier; `fs.watch`, `chokidar`, or polling can close the last-inspection race; a filesystem snapshot from Node alone automatically excludes writers; changing file attributes/ACLs is an acceptable safe automatic migration policy.
- **Native scope matters:** Microsoft's Win32 `CreateFile` supports `dwShareMode`, including refusing other read/write/delete access; `FILE_SHARE_DELETE` also controls rename access. Even restrictive per-file handles require design and proof for **new files, directory entries, hardlinks/junctions, filesystem/volume variants, sandboxed Obsidian and external editors**, and recovery after process termination. Do not treat opening all known files as sufficient to block creation of previously unknown paths.
- The existing D86/D126/D127/D128 WAL `wx+` lock remains valid **cooperative exclusion for this WAL protocol**, not a write fence over unrelated local Vault files.
- Neither holding handles nor comparing local stat/mtime implies installed Obsidian is quiescent. D122 rejects open editors, but another application could still write after the final check.

## Architecture options that require owner decision

| Option | Behavior | Benefits | Limits / recommendation |
| --- | --- | --- | --- |
| **A — Continue fail-closed Preview-only, research real OS fence in isolated audit** | No production cutover; keep D90/D91 same-repo three-branch topology and all release blockers | No implicit data-loss policy or Native Helper shipped | **Recommended now**; owner previously approved Native OS Helper research/PoC in an isolated audit worktree, **not** a production architecture choice |
| B — Cooperative plugin-only pause + read/hash revalidation, accept non-cooperating writes as residual risk | Can make UX less restrictive, but cannot guarantee external writer exclusion | Cross-platform Node implementation and low install friction | **Not sufficient** to satisfy strict production cutover safety; must not silently downgrade the blocker |
| C — Approve a dedicated native OS capability/architecture | Design restrictive Win32 file/directory sharing plus cross-platform equivalents, recoverability, IPC, packaging, security review | Potential route to enforcing some non-cooperative writer exclusions | **Requires explicit owner approval before product integration**, plus separate isolated proof for creation/rename races, process death, Android/iOS, Windows power-loss durability and release support |
| D — Explicit offline/manual migration with an independently verified out-of-use Vault copy | Human-managed frozen source, no live initiation cutover | Fewer concurrent editor interactions | Operational policy/UX shift; **requires owner approval** and must not misrepresent an ordinary directory copy as an atomic snapshot |

No option is silently selected, no Native Helper is integrated, and no acceptance gate has been waived.

## Validation matrix

Tested on Windows x64 / Node v24.22.1. Focused D129 feasibility recovery **2/2**, full Recovery **82/82** (including independent OS process SIGKILL), Fast **936/936**, Fast repeat **10×936/936** (exit 0, no failures), Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, Production Build, GitHub E2E compile-only (3 bundles), metadata/package verification PASS. Bounded cryptographic Soak **100,000,000 bytes / 12 chunks / 2 parts** PASS, SHA-256 matched the independent reference digest. No live GitHub E2E or installed Obsidian manual qualification was performed.

## Reference API semantics

- Node.js documented `fs.open` file flags: https://nodejs.org/api/fs.html#file-system-flags (the `x` flag means exclusive **creation** of that path, not a directory-wide writer exclusion protocol).
- Microsoft `CreateFileW/CreateFileA` sharing behavior: https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew (sharing masks are compared for competing opens, and delete access also governs rename).
- The authoritative result for THIS repo is the reproducible **real Windows child-process test**, not documentation assumptions alone.

## Existing release gates stay blocked

The Wizard release gate in `docs/release-gates/reencryption-wizard.json` remains `status: blocked`. Windows Node-only parent/leaf directory `fsync EPERM` leaves true sudden-power-loss WAL durability **UNPROVEN**. Initiating-only transactional Branch/Passphrase/Index cutover, new-key provenance/recovery, numeric-pinned live GitHub three-branch acceptance, installed Windows two-device and mobile device qualification remain independent blockers.

Owner-approved topology **unchanged**: old Source independently writable, immutable frozen Backup at pinned original SHA, zero-parent orphan encrypted new-key Destination **in the same repository**; peers switch manually; no old-branch deletion, Github Actions, production Native OS Helper promotion, or live user-Vault write.
