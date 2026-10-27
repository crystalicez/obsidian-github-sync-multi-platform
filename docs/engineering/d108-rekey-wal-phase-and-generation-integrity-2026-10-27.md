# D108 — Encrypted Re-encryption WAL phase enforcement and generation-gap rejection

Date: 2026-10-27. **Internal security hardening; first-release Re-encryption Wizard remains BLOCKED.**

## Finding

D104/D102's three-branch coordinator required a one-time verified-Backup → Staging transition before creating Destination. But the **lower-level** encrypted `V4ReencryptionRecoveryJournal` still allowed a caller to upload Blob Intent or record a Destination Ref Intent after a verified Backup **without** recording `stageHandoffStarted`. Higher layers were guarded, but internal misuses could construct an authenticated WAL state with an implausible or skipped phase.

A separate WAL recovery condition was incomplete: each of the two alternating AES-GCM slots might decrypt correctly with its own generation, yet represent **nonadjacent generations** because an older valid slot was replayed. Normal alternating writes keep only the latest and immediately previous generations; accepting two authentic yet nonadjacent ones as a healthy run is inappropriate before irreversible Git mutations.

## Implementation

Updated `src/lib/v4/reencryption-recovery-journal.ts` with the following fail-closed rules:

- If the Backup ref has been independently observed, `recordUploadIntent` refuses any new Blob Intent until `recordStagingHandoff` records the authenticated, one-time phase transition. `appendReceipt` likewise refuses marking uploaded ciphertext without the transition.
- `recordRefIntent` for the Destination requires `stageHandoffStarted:true`, completed Blob staging (zero pending object intents), and a separately verified Backup ref. `markRefReadbackObserved` for the Destination also verifies the same phase proof. Backup ref creation still requires prior no-Blob state. Existing D80 **standalone staging-only journals** remain supported.
- The **read-side WAL validator** rejects otherwise-authenticated payloads where a Destination Ref exists without the phase marker or completed Blob intents appear after Backup confirmation without staging handoff. Such states cannot be promoted to valid Recovery evidence.
- When both alternating encrypted slots authenticate, their generation numbers **must differ by exactly one**. A greater gap (e.g., newest gen 6 + replayed authentic gen 1) is rejected with `V4ReencryptionJournalRecoveryRequiredError`, not a guessed "latest" state. A corrupted/missing sibling slot remains subject to the prior D103 fail-closed mutation guard. Neither the WAL nor the coordinator authorizes auto-recreate, branch overwrite, or initiating-device Cutover.

No new API can promote the WAL to a migration authorization token. This is protection against malformed/stale persistent state, not a proof of OS power-loss durability or a way to resume a partially completed run automatically.

## Testing and evidence

- `tests/v4/reencryption-recovery-journal.test.ts` adds D108 regressions for attempts to record Blob/Destination Intent **without the one-shot staging handoff** and for a **valid AES-GCM/MAC-protected but replayed old generation slot**. Confirms no mutation, no implicit retry/cutover and manual Recovery requirement.
- Existing D101/D103 real/mock WAL tests were adjusted to follow the explicitly approved Backup → verified Backup → one-shot staging → Blob/zero-blob → Destination order. No change to GitHub connectivity or live Vault.
- Focused Journal **17/17**, desktop real Windows WAL **10/10**, full Fast **882/882**, Recovery **79/79**, Resource **11/11**, Feasibility **136/136** PASS. Maximum Strict TypeScript, production build, GitHub E2E compile-only (three bundles), package and metadata validation all PASS.

## Hard release blockers (no owner decision changed)

- D86 Node.js Windows directory fsync `EPERM`: **crash-durable WAL is still unproven**; successful filesystem readback and authenticated journal generations are not a power-loss guarantee. Do not weaken barrier or silently adopt Native Helper. Earlier owner decision: Node.js first, Native Helper isolated PoC only; architecture requires explicit owner approval.
- Live trusted three-ref migration coordinator, crash-safe initiating-device-only settings/key/index Cutover and zero local edit loss; true cross-process edit/IO fence, full credential/manifest provenance and interrupted restart acceptance are not complete.
- Pinned numeric test repo ID `GITHUB_E2E_EXPECTED_REPO_ID` and actual disposable GitHub three-branch E2E/installed two-device Windows/macOS/Linux/mobile acceptance still pending. No GitHub Actions, no tests with files larger than 100 MB and no real user Vault operations this stage.

Gate `docs/release-gates/reencryption-wizard.json` remains `status:"blocked"`, Wizard stays Preview-only, D90/D91 old Source remains independently writable and separate Backup/orphan Destination branches are preserved.
