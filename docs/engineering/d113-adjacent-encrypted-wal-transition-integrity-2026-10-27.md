# D113 — Verify actual phase ancestry between adjacent encrypted WAL slots

Date: 2026-10-27. **Internal fail-closed security hardening; Re-encryption release remains BLOCKED.**

## Finding

D108 required both valid AES-GCM encrypted WAL slots to have **adjacent numeric generations**. This is necessary but insufficient to prove that the newest slot is the actual next state of the older one. Two independent writers, reused snapshots or replayed authentic same-run slot data could each pass MAC, key/run/source/destination identity and the generation-adjacency test, while the pair represents **divergent histories**: for example, generation 2 stores a pending Git Blob receipt for A, but generation 3 confirms Blob B from another state line.

The WAL must reject any incompatible adjacent pair instead of treating the higher generation as authorization to mutate Git.

## Implementation

`src/lib/v4/reencryption-recovery-journal.ts` now has a strict `isAdjacentWalTransition` verifier invoked when **both alternate slots authenticate**. Each valid single-generation advancement must match **exactly one** existing journal API transition:

- append one immutable Blob upload intent; or move precisely that pending Blob intent to its matching completed receipt;
- append one create-only Backup/Destination ref intent; or move precisely that pending role+repo+commit+tree+manifest ref to its verified readback;
- begin the one-shot verified-Backup→Staging phase;
- seal the one-shot pre-commit Candidate preparation SHA-256;
- record exactly one prepared Candidate commit/tree/manifest SHA-256 receipt.

Every unrelated field is required to remain unchanged across the transition. An unexpected replacement, disappearing receipt, divergent path/commit/SHA, simultaneous multiple mutations or same-state increment forces `V4ReencryptionJournalRecoveryRequiredError` **before** the journal can be trusted for Git object/ref mutations. Previous D80 standalone Blob staging remains supported.

This is an **integrity and cross-slot ancestry check**, not a cryptographic chain of all historical generations, a defense against an actor who possesses the WAL key and can rewrite both slots as a consistent fake history, or a proof of filesystem power-loss durability. `load()` and the required `assertHealthySnapshot()` fail closed on contradictory authentic histories.

## Tests

- Added `D113 rejects two individually authenticated adjacent WAL slots from divergent same-run histories`: two independently generated but correctly encrypted records share the same key, run/source/destination identity and generations 2/3. The older slot has Blob A pending and newer slot Blob B completed; `load`, `assertHealthySnapshot` and any subsequent upload intent all require manual recovery.
- Added a control case showing a real, correctly consecutive Blob intent→receipt transition survives restart and still returns `requiresRemoteRevalidation:true`, `permissionToPublish:false`, `cutoverAuthorized:false`.
- Existing complete three-branch Backend tests remain compatible: encrypted Journal **24/24**, orphan Git publication simulation **45/45**.
- Full local verification: **Fast 906/906 PASS**, **Recovery 79/79**, **Resource 11/11**, **Feasibility 136/136**, Maximum Strict TypeScript, production build, GitHub E2E compile-only (3 bundles), package and metadata validation **all PASS**.
- No live GitHub ref mutation, installed Obsidian multi-device migration, user Vault writes or physical power-loss test in D113.

## Unchanged mandatory production blockers

- **D86 Windows Node-only directory fsync EPERM** still prevents proving WAL durability over actual sudden power loss. A valid two-slot transition cannot waive the OS durability requirement.
- Actual trusted end-to-end migration writer/cutover, secret provenance, physical cross-process Vault edit fencing, Windows installed two-device/mobile restore, and real guarded same-repository Source/Backup/Orphan-Destination GitHub E2E remain unqualified. The disposable real GitHub test still requires a **verified numeric `GITHUB_E2E_EXPECTED_REPO_ID`**. Never guess or bypass the repository safety pin.
- Owner D90/D91 decisions unchanged: Source remains independently writable for other devices, Backup is frozen at pinned old-key SHA, Destination has a fresh zero-parent encrypted branch in the SAME repo. Never force other devices to switch, merge histories, delete branches, add GitHub Actions, silently approve a Native Helper or weaken the release gate.

`docs/release-gates/reencryption-wizard.json` remains `status:"blocked"`; user-facing Wizard remains preview only.
