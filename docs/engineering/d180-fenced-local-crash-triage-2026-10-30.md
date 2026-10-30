# D180 — Fenced local crash-window triage, still uncommitted

Date: 2026-10-30. Status: **read-only diagnostic API**, Wizard **Preview-only**, release gate **blocked**.

## Problem and boundary

D179 proved that separate Source Settings, SecretStorage, authenticated WAL, local Source/Shadow/Intent and all Destination Git encrypted content were coherent **before** Cutover. There is still no independently authenticated **committed** Selector/Receipt or a crash-transactional Settings/SecretStorage/active Index switch.

The older D139 classifier could recognize consistent Source/Source and Destination/Destination observations, but it was not a single **fenced post-restart triage** that also authenticated D176 Prepared Selector and D173 Sync Fence while rejecting an unexpected `selector.json` or hypothetical D142 receipt residue. In particular, **Destination-looking Settings plus Index are not an authoritative committed migration**.

New `src/lib/v4/reencryption-fenced-local-crash-triage.ts` exports `inspectV4FencedLocalCrashTriageAfterRestart()` using the D172/D176 pinned identity + encrypted journal key and the **same initiating-device cooperative lease** for the entire inspection. It is diagnostic only; it invokes **no write methods** and requires no GitHub client.

## Independent checks and outcomes

Under one nonreentrant outer lease, the inspector:

- Rejects mismatched Run/Source/Backup/Destination/commit/secret/device identity or unsupported risk acknowledgement, lost lease, missing SecretStorage values and changed settings/key/method identities.
- Validates exact canonical nonsecret D173 Fence under best-effort authenticated WAL readback, before and after local recovery. Fence directory presence remains a separate Sync **block**, including if its marker is torn.
- Rejects **any** future-looking Selector at `<Source>-rekey-selector-<Run>/selector.json`, the hypothetical proposed-receipt root `<Source>-rekey-proposed-<Run>` or its marker. Even a valid **test-vector AES-GCM selector** is not commit proof, so it is explicitly refused.
- Compares D170's exact nonsecret Local Cutover Intent serialized bytes and unkeyed SHA-256 (derived from independently pinned identity) across reads. An unkeyed checksum is not authentication; it cannot authorize a switch.
- Authenticates the separate D172 AES-GCM `prepared.json` with the pinned 32-byte journal key, checks its size and exact identity, and reads the D165 best-effort WAL twice with no pending intents or ref publication authority.
- Invokes D139/D171 read-only local crash inspector under a **borrowed held lease**, classifying Settings-first, active-Index-first, matched Source and Destination-looking situations. D176's full Source/Intent/Prepared recheck is additionally required for a Source classification. The independent Fence, raw Intent and encrypted Prepared are checked again even in Destination-looking cases, where D176 Source-only restart cannot be applied.
- Rechecks original settings, old/new SecretStorage values, WAL, Marker/Selector absence, exact Fence and storage method bindings. Any changed readback or uncertainty denies a positive classification.

Nonsecret reason codes allow future Manual Recovery UI to distinguish:

| Observation | Reason | Meaning |
|---|---|---|
| `source-prepared-uncommitted` | `source-still-selected` | Source remains selected; preparation is not a commit |
| `destination-observed-without-commit-proof` | `destination-looking-without-authoritative-commit` | Matching Destination-looking Settings/Index are **not** durable authorization |
| `manual-recovery-required` | `mixed-or-changed-local-state` | Half-switched Settings-first or Index-first, or ambiguous state |
| `manual-recovery-required` | `unrecognized-selector-or-commit-artifact` | Unexpected Selector or proposed receipt residue, even when test-vector AES-GCM authenticates |
| `manual-recovery-required` | `missing-or-invalid-prepared-evidence` | Missing, torn or changed local Intent/Prepared |
| `manual-recovery-required` | `fence-wal-or-storage-uncertain` | Fence/secret/WAL/lease/storage identity missing, stale or changed |

**All** report variants set `localCutoverAuthorized=false`, `resumeSyncAuthorized=false`, `rollbackAuthorized=false`, `remoteWritesAuthorized=false` and `oldPassphraseCleanupAuthorized=false`. No mutation, automatic retry, selection, branch cleanup or Fence unarm is implemented.

## Verification

Six new D180 focused scenarios cover: read-only authenticated Source with unchanged local files; both Destination Settings/Index after an interrupted cutover (still no commit authority); Settings-first and Index-first torn windows; unexpected proposed-root/marker or an **authenticated future-looking test-vector selector**; missing/tampered prepared marker and unkeyed intent, wrong checksum, stale WAL, foreign/missing Fence, missing old secret; and Settings/new secret swapped during awaited encrypted Prepared reads. The existing D172 Windows filesystem WAL test was extended to **release and reacquire a real Node Windows encrypted WAL lease**, then run D180 and reject an unexpected Selector. The test local Index/Selector adapter is still in-memory; no installed Obsidian migration or physical crash durability is claimed.

**D180-focused 6/6 PASS, Full Fast 1179/1179 PASS**, Maximum Strict TypeScript, Production Build, Recovery, Feasibility, Resource **11/11**, GitHub E2E compile-only **3 bundles**, Metadata and Package validators, and bounded **100,000,000-byte** SHA-256 cryptographic soak all **PASS**. No credentialed live GitHub E2E or installed Desktop/Mobile physical cutover.

## Remaining release blockers

D180 does not define a committed receipt, authorize a settings/secret/index transition, or decide whether to recover automatically from a torn migration. A *separately authenticated authoritative committed Selector and Receipt* plus tested Windows Node best-effort ordering, fatal interruption handling, cross-process/multi-device writer gating, guided Manual Recovery and installed acceptance remain release blockers. Matching encrypted Prepared evidence and WAL readback are **not** proof of physical power-loss durability; Windows directory fsync remains unsupported.

Do not enable the installed Wizard Run or release gate, silently choose Destination, resume paused Sync, clean the old passphrase, delete Source/Backup/history, add Native Helper or GitHub Actions, merge or release. Preserve three-branch owner policy and the explicit owner-approved best-effort limitation. `docs/release-gates/reencryption-wizard.json` remains **blocked**.
