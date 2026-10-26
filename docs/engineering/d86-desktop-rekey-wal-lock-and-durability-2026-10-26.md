# D86 — Desktop rekey WAL filesystem adapter, exclusive process lock, and durability limits

Date: 2026-10-26 (Asia/Bangkok). Base clean/pushed D85 `1ddad4ebb3ec531b5323f5c8ee9ff82e1a22bc22`. Isolated `.worktrees/d86-desktop-wal-durability`, `audit/2026-10-26-d86-desktop-wal-durability`.

## Goal

D80's encrypted two-slot WAL + D81's fail-closed upload-intent protocol use a generic `V4LocalIndexAdapter` and an *injected* exclusive lease assertion. Neither has shown an OS-level filesystem writer lock or sync guarantees. D86 creates a **Desktop/Node-only, non-production-wired adapter** to test these assumptions without deciding the owner's backup provider, source-client freeze/cutover policy, or migration writer.

## Implementation

New `src/lib/v4/reencryption-desktop-wal.ts` exports `acquireV4DesktopRekeyWalStorage({rootAbsolute,journalRoot})`. A trusted caller explicitly supplies an **existing absolute private root**; D86 does not choose a backup location or touch any real vault. The relative WAL path is bounded to safe ASCII segments and only exposes two fixed `slot-{0,1}.json` files, not general vault-file operations.

- Validate root/parent directory types, resolve and reject symlink/junction and unsafe relative WAL paths. Protect slot reads and writes from existing symlink entries, unexpected files, traversal and wrong names.
- Create an exclusive `.exclusive.lock` via Node `fs.open("wx",0o600)`. An independent second Node process cannot acquire it. Bind lease to an open file descriptor and random token, verify inode/device/token before each adapter IO. Losing/deleting/replacing the lock invalidates the old owner's writes. **Never** auto-reclaim an existing lock by PID/time; abnormal termination leaves the lock for manual recovery. There is no automatic stale-lock deletion.
- WAL writes create a new randomized private `.slot-*.tmp` using `wx`, `writeFile`, **file `FileHandle.sync()`**, close, then replace the chosen slot via `rename` WITHOUT deleting the previous valid slot first. A failed rename refuses success; temp cleanup is best effort except missing temp. Existing D80 AES-GCM/generation readback still checks journal content. A staged slot survives process-object recreation and retains encrypted receipt confidentiality.
- Attempt **directory `fsync`** after lock creation and slot rename. `assertCrashDurable()` **must throw** unless the host supports directory `fsync` and a successful call was observed. It also checks the lease is still held. This is an explicit safety gate; even on a filesystem that accepts directory `fsync`, D86 alone is **not** a simulated power-failure proof, nor does it establish atomicity on every filesystem.
- Scan all WAL directory entries while owning the lock before reporting a usable adapter. Any unrecognized `.slot-*.tmp` or other residue means **manual recovery required**, rather than silently trusting an older valid generation or deleting possible crash evidence. An interrupted/wrong slot remains available for investigation.
- Calls return `adapter` (the existing V4LocalIndexAdapter interface), `assertExclusiveStageLease()`, `assertCrashDurable()`, `release()`, and `lockPath`. This is not connected to the production Re-encryption Wizard. A secure caller must additionally pin repository identity and require BOTH lease and durability assertions before starting any irreversible Git network mutation.

## Actual Windows finding: directory fsync unsupported

Ran a separate no-user-data Node filesystem capability probe on the Windows host. `fs.open(directory, "r")`/directory fsync returned **`EPERM`**; this host cannot establish a directory-entry persistence guarantee through this Node API. D86 therefore **fails `assertCrashDurable()`** here and MUST NOT be considered production power-loss safe. The adapter's disk writes can be used for isolated testing, but their completion is **not sufficient proof to start Git upload**. Further research/OS-native helper or a different explicit durability strategy and OS acceptance would require owner review before integration.

## Regression verification

New `tests/v4/reencryption-desktop-wal.test.ts`: 9/9 desktop real-filesystem cases in a disposable `.tmp/d86-desktop-wal-*` under the isolated worktree, physically writing and reading two-slot encrypted WAL:
1. Begin, upload intent, receipt, release, reacquire, re-read authenticated generations, no unencrypted receipt/path, no extra files.
2. Verify actual directory `fsync` capability and require `assertCrashDurable` to refuse unsupported hosts.
3. Second lease in same process and a **different real Node process** is rejected by OS `wx`.
4. Existing lock is not reclaimed automatically.
5. Real terminated child process leaves stale lock that must be reviewed.
6. Traversal, unsupported path and filename writes never escape WAL root.
7. Symlink/junction WAL directory and symlinked slot cannot trick writer into touching other files.
8. Unrecognized temporary interrupted WAL slot prevents restarting, preserves its evidence.
9. Lock disappearance causes old writer assertions / mutations to reject, not silently proceed.

All tests operate only in the user-authorized repository's isolated test worktree and clean their disposable scratch data. A separate tiny OS capability probe used a throwaway OS temp directory and removed it. No actual GitHub mutation and no installed Obsidian runtime change.

Frozen offline dependency install, strict `pnpm build`, focused tests, full `pnpm test:fast`, `pnpm test:resource`, `pnpm test:recovery`, `pnpm test:feasibility`, three E2E bundles compiled (not executed), metadata/package validators all PASS. No GitHub Actions, master merge, release, or user vault mutation.

## Remaining risks and production gates

- **Windows directory `fsync` unavailable through Node.js on tested host**, so D86 does not provide a production-approved durable WAL. The desktop adapter MUST remain disconnected from automatic migration writers.
- `fsync` calls and successful rename do not prove power-loss behavior across Windows/macOS/Linux and filesystems; tests exercise process restart, not real host power interruption. TOCTOU file replacement by an actively malicious local peer, hardlinks, OS filesystem redirection and unreliable/networked filesystems remain unproven. Production path root ownership/permissions and lease lifecycle require integration review.
- Lock files left after crashes require **manual** reconciliation and securely controlled unlock UX; never infer stale status from age alone. Mobile cannot use Node OS filesystem lock and needs an independent best-effort-safe approach.
- D80 WAL is 2 MiB bounded; a paged journal or bounded checkpoint plan is not implemented. D82 remote blob reconciliation, D83 exact-commit proof and D85 scratch backup rehearsal **do not** authorize cutover.
- Re-encryption Wizard release gate remains **blocked**, only approved orphan topology A passed; six checks pending. Old-branch devices' Sync freeze vs reconciliation and real independent backup medium are **not approved**; do not choose either implicitly.

Next safe task: examine a Windows-native durable directory-entry strategy in a separate PoC **only with owner approval for native helper**, or refactor migration to a demonstrably durable OS-independent transaction protocol with independent duplicate evidence and crash tests. Separately test production-style backup isolation and second installed Obsidian restore.
