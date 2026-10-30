# D172 — Authenticated prepared Selector evidence, isolated from the active Selector

Date: 2026-10-30. Scope: guarded internal pre-Cutover stage. **Release blocked.**

## Change

D170 persistently records the nonsecret, uncommitted local Intent, and D171 can re-open and classify its Source/Shadow/WAL evidence under the Windows Node best-effort checkpoint policy. D172 adds an encrypted, **non-authoritative** prepared Selector record rather than prematurely switching the plugin's active Selector.

`src/lib/v4/reencryption-prepared-selector-stage.ts` adds `stageV4BestEffortPreparedSelectorEvidence()`. It requires the owner's exact `accept-best-effort-power-loss-recovery-risk` acknowledgement and one exclusive cooperating initiator lease across the stage. It pins a full D142 proposed-cutover identity, Source settings, the WAL generation and method bindings, and the 32-byte journal key. Before any disk mutation it invokes D171's prepared-Intent restart inspection: authenticated WAL, complete independently pinned Source and Shadow indices, both secrets available and Settings still selecting **Source**. It verifies the WAL's exact Backup/zero-parent Destination commit, tree and manifest receipts with the existing D142 `matchesV4ReencryptionPreparedWal()`.

The record is AES-GCM authenticated with a **separate HMAC-derived key, AAD, record phase and context** (`v4-rekey-prepared-selector-evidence-v1`), not the earlier in-memory `destination-selector-test-vector-uncommitted`. It is stored exclusively at:

`<source-index-root>-rekey-selector-<runId>/prepared.json`

The existing `selector.json` is never created or modified. A pre-existing Selector, partially created preparation directory, or completed preparation is not reused. One in-process writer per adapter/path is allowed, but that cooperative lock is not a cross-process filesystem fence. A lost write acknowledgement, WAL discrepancy, changed source settings or damaged encrypted readback fails closed with the residue intact for Manual Recovery. The stage checks D171 again after the isolated write, before returning the **prepared-uncommitted** result. It neither changes either Index root nor Settings/SecretStorage nor GitHub refs, nor grants Sync, Cutover, rollback or old-key cleanup.

`inspectV4BestEffortPreparedSelectorAfterRestart()` is a separate **read-only** reader. It checks the isolated prepared record twice under a caller-held lease, decrypts it against pinned Identity and independent journal key, validates D171 Intent/WAL/Source/Shadow/Settings in both passes, requires no active `selector.json`, and refuses torn, malformed, stale, changed or foreign records. Even authenticated evidence is **not an atomic local transaction or Commit Receipt**. No power-loss durability is claimed: Windows Node directory `fsync` remains unsupported and non-cooperating OS processes/ABA are not fenced by the WAL lock.

## Verification

- D172 focused stage **8/8 PASS**: isolated one-shot encrypted write; read-only restart; valid AES-GCM but wrong domain rejected; no risk acknowledgement, changed remote identity, missing D170 Intent, incomplete WAL; lost write response retaining residue; changed settings mid-check; concurrent same-adapter attempts; tampering, wrong key and active Selector collision.
- A disposable **real Windows Node encrypted WAL** was acquired, populated with exact Backup/Destination receipts, used for the prepared stage, then the handle was released and re-acquired. The fresh WAL storage authenticated the prepared record under a new reader. Its Source/Shadow indices and prepared record still use an in-memory adapter; this does **not** prove installed Obsidian persistence or physical power-loss recovery.
- Existing D146 Selector prototype tests **6/6 PASS**. Full Fast, Recovery, Feasibility, Resource, Maximum Strict TypeScript, production Build, GitHub E2E compile-only (3 bundles), metadata/package validators and exactly 100,000,000-byte cryptographic SHA-256 soak all **PASS**. No credentialed GitHub E2E was run.

## Next blockers

D172 is **not** the authoritative Selector and does not create a committed local Cutover. Next implementation must define the actual persistent commit/selector ordering, on-disk readback boundaries, Sync startup fencing, Settings/SecretStorage selection, complete torn-write/restart/manual recovery classification, and installed Desktop/Mobile acceptance with a disposable GitHub repo. Preserve the original Source branch and verified frozen Backup; do not automatically delete old secrets or branches. Keep `docs/release-gates/reencryption-wizard.json` status `blocked` and the Wizard Preview-only. No GitHub Actions or Native Helper without approval.
