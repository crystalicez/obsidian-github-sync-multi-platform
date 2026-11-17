# Stage D411 — Expose installed read-only Recovery inspection in the Re-encryption Wizard

Date: 2026-11-12. Scope: integration of existing installed Recovery Runtime into the existing user-visible Wizard, without authorizing migration or touching real Vaults.

## User-visible gap

The Re-encryption Wizard's Preflight correctly refuses Source verification and branch preview while an incomplete/pending local WAL migration Fence exists. Previously the Wizard itself offered only static illustrative Manual Recovery text; the installed Runtime already had `inspectFencedReencryptionCompleteRecovery()` and the command palette exposed that read-only checker separately. A user encountering the blocked Preflight could not run the diagnostic from the Wizard where the problem was visible.

## Narrow integration

The Wizard's first Preflight step now has an **"Installed Re-encryption Recovery"** row and a deliberately opt-in **"Inspect installed Recovery (read-only)"** button. It invokes the existing live `V4Runtime.inspectFencedReencryptionCompleteRecovery()` without first calling `assertReencryptionSettingsSaveAllowed()`, because a pending migration Fence is exactly the case this inspector must be able to diagnose.

The Wizard snapshots the active Runtime, Sync and Settings-save generations, Vault, adapter and configured connection at open, then checks them before and after the asynchronous read. The result is ignored if the dialog was closed/reopened or its request was superseded. The operation uses the existing `busy` guard to avoid overlapping Preview actions; the underlying Runtime already rejects overlapping diagnostics and stale owner changes.

It displays only fixed safe text for:
- authenticated old Backup, WAL and complete Destination evidence **still fenced**; this never means migration is committed or that Sync/Cutover are authorized
- a present but incomplete/contradictory report requiring **Manual Recovery**
- unavailable, null, failed or stale inspection (**inconclusive**, not proof of no WAL/Fence)

It deliberately hides raw exception messages, paths, branch receipts, repository URLs, tokens and passphrases. It does not create/delete Git refs, start Sync, persist Settings, alter Obsidian notes, cut over the branch, grant Execute, or delete secrets. An earlier authenticated result is no longer displayed as authoritative after the connection/Runtime changes. The Wizard's static Manual Recovery examples are labelled as illustrations, distinct from any optional live inspection.

The isolated test Obsidian `Setting.addButton` stub now exposes rendered label, disabled state and click handler so UI regression tests exercise the real button callback, rather than directly invoking private methods. The native installed Obsidian smoke harness additionally clicks the real rendered button inside a **credential-free disposable Vault**, checks an inconclusive fail-closed result, and verifies the Wizard still has no Execute/Cutover action.

## RED before correction

New D411 tests in `tests/v4/reencryption-wizard-ui.test.ts` initially failed because the original Preflight did not render an installed Recovery inspector button. Process `2f8a4bce-0f2b-4840-a7cd-1c8b96822543` exit 1, both tests RED on the old UI. One test confirms the button remains available even when the Preflight Recovery-save fence throws; a second confirms stale async completion and private backend failures cannot leak data or enable the next step.

## Verification

- Focused D411 UI cases: **2/2 PASS**, process `f0ed1742-5cfd-4bf5-9873-ca1b33488ff1` exit 0 after extending the test Setting stub.
- Entire Wizard UI suite: **33/33 PASS**, process `4e1c59f5-64d5-4e05-9d85-101a080004ad` exit 0, followed by post-drift refinement `bfaa739b-9f63-47c8-84c9-9ecddf5a0730` 33/33 PASS.
- Runtime tests `3ef0b4b1-f857-4fec-9466-962709245c5f`: **31/31 PASS**.
- Recovery suite `089e33bd-187e-46ea-9933-835fc99bd122`: **93/93 PASS**. Resource suite `b8e1b960-a187-4db2-b551-f92e21dcd5ec`: **11/11 PASS**.
- Maximum Strict TypeScript `9c2b14eb-f1c9-41d3-890b-d90b40d81aa6` and production Build `1f1933de-d2b8-4874-8553-09dae64f7641` exit 0 after final UI refinement.
- Native isolated Obsidian Desktop smoke `30d1352d-6ac7-4da8-8a29-f7a7ebc43370`: **EXIT 0**, UI command and Recovery checks PASS, no Sync, no real GitHub, synthetic Vault cleaned. A second native pass after the final connection-drift refinement is pending terminal confirmation and is recorded in the handoff.
- The first full Fast attempt `b672a2d6-e990-4005-8fd5-cd7efaa1493f` **FAILED in ordinary shard 4** because the new test-only `Setting.addButton` simulation initially lacked `setWarning()` used by unrelated Settings UI tests. This was a **real test harness compatibility regression**, not an application bug. Added compatible no-op `setWarning`, `setCta`, `setTooltip` and `setIcon` chaining to the stub while preserving text/click/disabled rendering. The exact failed cohort `--shard=4/12` then **passed 163/163**, process `18ceeed2-4102-41f8-8f7a-6ed8089c290f`; all Wizard UI cases passed again 33/33, process `2b9310dd-4c92-413a-b0e3-952a47c78c80`, and max-strict TypeScript `b350a3e3-abc5-4a45-973d-06c857a5f60c` exit 0. Do **not** count the invalidated first Full Fast attempt as qualification.
- The final source-fingerprinted Full Fast result, if re-run, is recorded only after its terminal exit code and source fingerprint in the handoff file.

## Release constraints

This does **not** enable a migration. First release remains Sync + Re-encryption together; `docs/release-gates/reencryption-wizard.json` stays `"status":"blocked"` with outstanding real installed Source→Backup→Destination→restart-safe local Cutover, stale-device user flow and physical Android/iOS acceptance. This work intentionally adds no public Execute action while those prerequisites are unfinished.

## Next integration milestone

Create an installed, disposable owner-orchestration rehearsal from the Wizard's currently verified immutable Source to verified Backup and fully authenticated Destination **without Cutover**, under the already approved test repository and isolated Vault constraints. Prove recovery after Obsidian restart before considering a production Execute toggle or any persisted branch/secret switch. Do not change the still-unapproved post-commit Sync cleanup reporting policy.
