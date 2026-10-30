# D177 — Read-only three-branch Git ref and encrypted WAL revalidation

Date: 2026-10-30. Status: internal non-authorizing diagnostic; Re-encryption Wizard **Preview-only**, release gate **blocked**.

## Problem

D100/D169 can publish and independently verify the same-physical-repository Source, frozen Backup and zero-parent Destination. D173/D174 reserve and persist a Sync Fence, D176 binds encrypted prepared Selector evidence to the exact run. A historical publication report alone is **not** evidence that GitHub refs have remained unchanged at restart. A migration should refuse to reuse an old result if the Source, Backup or Destination ref moves or if WAL and Fence refer to different runs.

## Implementation

- `src/lib/v4/reencryption-fenced-three-branch-revalidation.ts` exports `inspectV4FencedThreeBranchPublicationAfterRestart()`, a **read-only** pre-Cutover inspection. It validates the full D142 proposed identity, exact D100 remote publication report identity, explicit owner-approved Windows Node best-effort risk acknowledgement, expected physical GitHub repository ID, and live same-run D173 Fence. It reuses D176's canonical independent Sync Fence inspector rather than duplicating its parser.
- The inspector holds the caller's cooperating initiating-device lease for the whole observation and requires D165 authenticated best-effort WAL triple readback and full D142 two-ref Snapshot match: exact Backup source Commit/Tree, new zero-parent Destination Commit/Tree/Manifest, prepared Candidate receipt, no unresolved upload or ref intents, generation pinned, `cutoverAuthorized=false` and `permissionToPublish=false`.
- Source, Backup and Destination each have their **own read-only GitHub client**. It verifies expected branch, matching pinned physical repository ID/name, a consistent default branch that is neither Backup nor Destination, exact ref SHA, independently fetched Commit SHA and Tree SHA, and zero parents for Destination. All three clients are re-read in a **second complete pass**, with the same pinned default branch, WAL, Fence and original method bindings across asynchronous reads. Any missing branch, moved ref, changed default, foreign repository, mutated scope/reader, lost lease or stale WAL returns `manual-recovery-required`.
- The report `three-refs-match-pinned-wal-uncommitted` is deliberately labeled `read-only-current-git-refs-and-authenticated-uncommitted-wal` and `completeRemoteContentReverified: false`. This stage **does not** rerun D83/D137's complete ciphertext and decrypted plaintext parity across all Git objects, and cannot authorize a Git mutation, Selector/Settings/Index switch, Sync resume, rollback or old-key/branch cleanup. Matching refs can also be moved and restored between observations by a noncooperating writer (ABA); no cross-process OS or remote lease is claimed.

## Verification

New `tests/v4/reencryption-fenced-three-branch-revalidation.test.ts` **8/8 PASS**: exact canonical fence + WAL + mock Git refs and no writes; missing/foreign/torn marker, wrong Run, Source/Destination scope and risk; moved each branch; wrong tree, non-orphan Destination, unsafe default branch, foreign physical repository; mutation of Git ref or client method during awaiting; a branch/default changing between the two complete reads; stale WAL generation, missing Destination receipt, pending ref and lost stage lease; holder skipping the body; and a **real Windows Node encrypted WAL** with complete Backup/Destination receipts, then closed/reopened through a fresh filesystem lease before independent Git ref inspection.

Full Fast **1164/1164 PASS**; Recovery, Feasibility, Resource **11/11**, Maximum Strict TypeScript, Production Build, GitHub E2E compile-only **3 bundles**, metadata/package validators and bounded 100,000,000-byte SHA-256 cryptographic soak pass. No credentialed GitHub live E2E, installed Obsidian Desktop/Mobile acceptance, physical power-cut simulation, branch mutation or installed Wizard Run in D177.

## Next blockers

The correct next security boundary is to compose fresh **complete** remote encrypted-content revalidation with D176's fenced Intent/Prepared Selector and a stable initiator/desktop WAL, then design an independently authenticated *committed* local Selector plus transactional Settings/SecretStorage/active Index switch and Manual Recovery UI. Do not substitute read-only D177 ref match for the comprehensive D83/D137 content verification or a power-loss durable Commit Receipt. Preserve Source and Backup; no automatic unarm, Sync resume, old-key deletion, native helper, GitHub Actions, merge or release. Keep `docs/release-gates/reencryption-wizard.json` `blocked`.
