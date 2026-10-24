# D74 — Owner-approved Option A: a new orphan Git branch for complete re-encryption

Date: 2026-10-24 (Asia/Bangkok). Owner **explicitly approved** the same-repository/new-branch version of Option A. This document supersedes D66–D73 references to undecided A/B topology, not their existing engineering evidence or release blockers.

## Fixed owner architecture (do not silently vary it)

1. In the **same physical GitHub repository**, use a distinct **new branch**, not a separate repository and not the existing source branch. It must be proven absent before publication.
2. The destination's first Git commit is a **new root commit with zero parents**. Its tree is built independently, **without** a `base_tree` copied from the source, and contains newly encrypted metadata and all required current content. Never set its parent to the source commit or create the new branch by copying the source ref.
3. Generate a **fresh KDF salt** and destination keyring bound to the *destination* `owner/repo#new-branch` identity. Validate new PBKDF2 iterations (600,000–1,200,000). All destination logical names, content objects (single/pack/multipart), metadata, journals and relevant identity references must use the new keyring and scheme—no rename-only or config-only “rotation”.
4. Preserve the source branch and previous ciphertext **untouched** as a recovery source. No force-push, history rewrite, branch deletion or automatic secret/key erasure. Old Git objects may still be accessible from the old branch, forks, clones, and caches to holders of old keys. New orphan ancestry **does not erase history from the repository**.
5. Obtain a complete authenticated source snapshot pinned to an exact commit, verify every live ciphertext object and a separate accessible backup, quiesce Sync/WAL, enumerate user edits/conflicts, and coordinate other devices before migration publication.
6. Upload newly encrypted immutable objects and construct a new tree from scratch; make an **empty-branch-only** ref creation after verified absence and exact repository-ID/head checks. Recheck after ambiguous GitHub success/failure and never overwrite an unexpected destination. A double-absent probe is not an atomic CAS; a collision at ref creation must fail closed.
7. On the second independent device, decrypt and restore the destination, compare count, each plaintext hash and size, directory/Unicode path integrity, rename/delete/recreate behavior and multipart/pack content. **Only after verified acceptance** offer a separately confirmed switch for other devices. Old devices must not silently push stale data into either branch. Source retention is a recovery policy; it must not be mistaken for permission for continued uncontrolled writes.
8. On crash, cancellation, missing data, 404 ambiguity or ref race, leave source untouched and the device's active connection unchanged, retain verifiable stage/backup and resume only after exact evidence. Never auto-commit partial inventory or re-encryption.

## D74 implementation (no migration writes)

- `src/lib/v4/reencryption-orphan-branch.ts` exposes **pure** `planV4OrphanReencryptionDestination`, validating same GitHub owner/repository, different non-default safe destination branch, source pinned full SHA and identical positive numeric GitHub repository IDs. Returns a frozen plan whose status is **`blocked-pending-migration-implementation`**: it does not authorize publication.
- `assertV4OrphanDestinationRefObservations` rejects a missing/changed source HEAD, either non-absent/ambiguous destination observation, or switched physical repository identity; returns an expressly non-authorizing **`prepublication-ref-observations-only`** report. Production must gather those observations through trusted API calls and still use a collision-safe ref creation operation.
- `assertV4OrphanReencryptionRoot` validates a proposed commit has **zero parents**, new SHA, different tree SHA, exact destination `repoId` in encrypted V4 config, fresh KDF salt and bounded new iteration count. Returns only **`orphan-commit-topology-only`**, *not proof of new object bytes or successful encryption*. Full exact-commit remote validation and independent second-device proof remain mandatory.
- D67's read-only preflight now reports `migration-implementation-incomplete` rather than the obsolete `destination-topology-unapproved`, and remains **blocked** even if all synthetic evidence flags are true.
- `docs/release-gates/reencryption-wizard.json` records the *owner-approved topology only* as `passed`; the overall release status remains `blocked` and **the other six checks remain pending**.

## Verification and no-go areas

D74 fail-first test for absent topology module then eight focused regressions for branch/repo/ID/ref checks, zero-parent root requirement, source-tree reuse prevention, KDF/salt changes, absent remote ref evidence and immutable nonsecret previews. Updated D67 preflight six regressions and first-release gate regression check that only topology approval passes. Frozen offline dependency install, maximum strict TypeScript + production build, full fast/resource/recovery/feasibility suites, GitHub E2E compilation, metadata/package validation pass.

**No actual destination branch was created in D74**; no re-encryption writer, cutover UI, backup/WAL orchestration, native second-device restore, or automatic stale-client fencing exists yet. The D73 live GitHub source-verification evidence remains valid for the source read path but is **not** a migration acceptance test. The Wizard stays a hard blocker before first public release.

## Owner-policy detail to resolve before actual cutover

A branch with no shared commit ancestry does not itself fence other clients. Before production migration, confirm the concrete freeze/coordination mechanism: all existing devices should pause old-branch Sync during and after migration until individually cut over, or an explicitly approved more complex reconciliation design. It is unsafe to infer that stale writes to retained source can be merged automatically. All unknown extra user edits/conflicts must be preserved rather than silently dropped.
