# D118 — Bind encrypted Desktop WAL reads to verified file handles

Date: 2026-10-27. **Conservative local filesystem hardening, not a production migration enablement.**

## Finding

The Desktop Re-encryption WAL adapter previously validated an encrypted slot using `lstat(filename)` and then later read through a second pathname lookup, `fs.readFile(filename)`. A concurrent external path replacement between those calls could redirect that second lookup to a different file, including a symlink pointing outside the designated private WAL directory. Additionally, a hardlink to an external file was accepted as an ordinary regular file because `isFile()` and `!isSymbolicLink()` do not detect hardlinks.

The adapter must not load other files by path, and it must fail closed on an ambiguous WAL file identity rather than accepting it for encrypted recovery or subsequent Git operations.

## Implementation

`src/lib/v4/reencryption-desktop-wal.ts` now:

- Refuses any WAL slot with `nlink !== 1` during the existing `safeFile` guard, covering `exists`, `read`, and pre-rename `write`. Such files are left untouched for manual investigation.
- Uses an actual `FileHandle` for the slot and obtains `BigInt` `lstat(filename)` and `handle.stat()` identities. Before reading any bytes it insists that both are regular single-link files with nonzero file inode IDs, and their exact **device and inode identity** match. A path swap after opening cannot redirect descriptor-based reads to a newly substituted pathname.
- Verifies size on the opened handle, not on an independently looked-up pathname. Uses bounded positional reads (up to 2 MiB plus a one-byte overflow check) rather than unbounded `readFile()`, so a concurrent file grow after initial stat cannot cause unbounded allocation.
- Applies the pinned-inode principle to the **exclusive lock token**: the handle is opened with create-exclusive `wx+` instead of write-only `wx`; `assertHeld()` requires a matching nonzero single-link inode and reads the token from that pinned handle, not a second pathname lookup. The initial write-only-mode draft failed Desktop WAL tests; the corrected read/write-exclusive mode passed.
- Closes the opened WAL slot descriptor in `finally` on success, oversized content, or a rejected identity. Uses `BigInt(0)` and `BigInt(1)` instead of BigInt literals to preserve the current TypeScript target and Maximum Strict TypeScript policy.

No automatic stale-lock reclamation, WAL format change, ref mutation, user-vault access, additional OS permissions, Native Helper, GitHub Actions or migration activation was introduced.

## Regression proof

In `tests/v4/reencryption-desktop-wal.test.ts`:

1. Create an external private file within a separate disposable directory, hardlink it into a fresh WAL slot on the same Windows volume and require that `adapter.exists`, `adapter.read`, `adapter.write`, and encrypted journal initialization all reject it. Original and linked contents remain identical and unchanged. If this Windows environment forbids creation of hardlinks, the test records the explicit environment limitation; the other WAL regression still runs.
2. Hardlink the *live exclusive lock* into a separate disposable directory and demand that live lease checks and WAL mutation refuse the duplicate-linked inode. Verify unchanged token bytes; removing the test-owned alias allows the original owner to release normally. No automatic stale-lock reclaim is performed.
3. Create an authentic encrypted slot, read and revalidate it through the handle-based adapter, replace its content with an oversized >2 MiB test string, and require that raw read rejects size and authenticated journal loading refuses the malformed slot.

Focused Windows Desktop WAL **16/16 PASS**; full Fast **916/916**, Fast repeated **10×916/916** (exit 0), Recovery **80/80**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript and production build PASS. Further repeat, package and bounded 100 MB soak results are recorded in `HANDOFF-NEXT-SESSION.md`.

## Deliberate scope limits

Verifying file descriptor identity narrows the WAL slot **final-component path-swap** risk; it does not prove that an untrusted actor cannot replace parent directories between path checks, nor can it replace a real cross-process vault-wide edit fence. Pathname race scenarios with a malicious actor intentionally mutating parent directories remain release-hardening work, and this adapter is an isolated Desktop rekey-stage proof, not an enabled Wizard.

Physical sudden-power-loss durability is still unproven on Windows Node-only directory `fsync EPERM`. Other mandatory blockers: crash-safe initiating-only Branch/Passphrase/Index cutover, trusted new key provenance, numeric-pin same-repository three-branch live GitHub E2E, and installed multi-device Windows/mobile restore.

Owner D90/D91 policy remains independent writable old Source + frozen Backup + zero-parent orphan encrypted Destination in the same repository. `docs/release-gates/reencryption-wizard.json` remains `blocked`, Wizard Preview-only, and no automatic source/backup cleanup, GitHub Actions, or Native Helper authorization.
