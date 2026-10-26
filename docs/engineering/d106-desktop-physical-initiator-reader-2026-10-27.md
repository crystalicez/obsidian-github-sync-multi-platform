# D106 — Physical desktop initiating-vault SHA-256 reader bound to real Obsidian runtime

Date: 2026-10-27. **Internal implementation and tested on a disposable Windows filesystem; end-user Re-encryption remains BLOCKED.**

## Owner policy

D90: independently writable old/source Sync may continue forever. D91: same physical GitHub repo with separate **old Source + pinned old-key Backup + new-key zero-parent orphan Destination** branches. Other devices opt in manually, never auto-pause/switch; no auto-merge/cleanup. No GitHub Actions or unapproved Native OS Helper; maximum strict TypeScript, no tests of physical files above 100 MB.

## Previously unresolved D105 trust boundary

D105 blocked Destination publication without a complete initiating-vault SHA-256 comparison to the pinned authenticated Source, but it depended on a **mockable injected local reader**. Obsidian's `vault.getFiles()` may lag external filesystem changes. Listing its cached TFile records alone can overlook newly introduced unsynced notes and unsafe links.

## Implementation

New `src/lib/v4/reencryption-desktop-initiator-reader.ts`:

- Uses actual Node `fs/promises` recursive, bounded physical vault inventory from a trusted existing absolute root. It **does not use Obsidian's TFile cache** and never creates/writes/moves/deletes local files. Applies one immutable captured V4 Sync scope including ignored paths/config exclusions.
- Fails closed on an untrusted/junction root, symlink/junction directory or file, **hardlinked regular file**, traversal, noncanonical/ambiguous paths, absolute paths, invalid file types, Unicode NFC case-fold collision, overly deep/large inventory and filesystem lookup errors.
- Opens files with a bounded **8 MiB maximum per read**, rejects unsupported sizes and uses `O_NOFOLLOW` where provided. Checks `lstat`/realpath for every component, compares physical file-handle `dev`/`ino`/`mtime`/`ctime`/`size` before and after hashing, and rechecks path identity to catch detectable replace/modify races. The D105 parity layer independently verifies every local plaintext SHA-256 against the authenticated pinned Source.
- The adapter requires four **live external guards**: exclusive migration lease, idle Sync/zero queued edits, captured Source configuration/scope unchanged, and enumeration of all open editors. It is still a **read-only precondition, not a durable OS snapshot or prevention of concurrent writes by other programs**. `lstat`/realpath and filehandle observations can have TOCTOU races; a future real Cutover transaction needs an independently proven event/IO fence.

`src/lib/v4/runtime.ts` now exposes `createReencryptionInitiatorLocalReader(assertExclusiveInitiatorLease)`. It binds the physical adapter to the **actual configured desktop vault root**, captured Source credentials and ignore/config flags, live V4 coordinator Sync/pending-queue state, staging activity, runtime disposal/credential generation, and Obsidian workspace open-editor enumeration. It rejects non-desktop/non-recoverable/network vaults and missing guards. The external lease callback is still a dependency; this method is not connected to Wizard publishing or device cutover, and cannot by itself certify the lease or durability.

## Verification evidence

The new `tests/v4/reencryption-desktop-initiator-reader.test.ts` uses **real disposable Windows filesystem directories** and existing Obsidian runtime fixture support. Cases include:
- Real scoped files/Unicode note bytes, plugin-private/config exclusions, full SHA-256 parity and no local mutation.
- Newly added unsynced physical note deliberately absent from Obsidian cache; exact same-size/mtime content edits; mutation mid-stream.
- Symlink/junction and hardlink rejection, traversal/invalid path, missing guards.
- The real V4 runtime binding rejects source branch/settings drift, open Obsidian editors, lost lease and unavailable editor enumeration; it reads actual files with mocked Obsidian TFile cache intentionally empty.
- D106 focused tests **10/10 PASS**. Full suite: Fast **878/878 PASS**, Recovery **79/79**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, production build, GitHub E2E compile (3 bundles), package and metadata validation all PASS.

## Remaining release blockers — unchanged

1. This is physical disk proof, **not** a cross-process write lock, OS atomic snapshot, or crash-safe initiating-device branch+secret+index cutover. Concurrent external writes after the final read remain possible; no production migration job, new credential installation or vault settings switching was run.
2. Windows Node-only WAL `fsync` on directory still fails `EPERM`: no power-loss durable intent guarantee. Do not weaken the barrier, invent success or introduce Native Helper without owner architecture decision. The test runtime lease callback can be a no-op and is **not** production lease proof.
3. New destination metadata/candidate/secret provenance, actual installed Obsidian 2-device and mobile acceptance, real GitHub 3-ref test with verified `GITHUB_E2E_EXPECTED_REPO_ID` safety pin, restart/power-loss/rollback and UX tests remain incomplete. No remote GitHub mutation or user Vault touched in this stage.

`docs/release-gates/reencryption-wizard.json` remains `status:"blocked"`. User-visible Wizard remains **Preview-only**. No GitHub Actions, forced cross-device updates, branch deletion or premature production claim.
