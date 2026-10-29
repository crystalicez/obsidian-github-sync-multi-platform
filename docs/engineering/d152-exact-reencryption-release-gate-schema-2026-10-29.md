# D152 — Strict release-acceptance manifest shape (first public release)

Date: 2026-10-29. Owner-approved architecture and strict crash-safe requirements remain unchanged. **Re-encryption Wizard is Preview-only; actual checked-in `docs/release-gates/reencryption-wizard.json` remains `blocked`.** No Native Helper, no GitHub Actions, no live Vault/GitHub mutation.

## Finding

Before D152, `requireReencryptionWizardReleaseGate()` required `status: qualified`, the exact accepted same-repository backup policy values and **seven known checks** marked `passed`. However, it did **not** reject additional object keys at the manifest root, in `backupPolicy`, or in `checks`. A future maintainer could add `physicalPowerLossQualification: pending` to the checks and (mistakenly) mark the overall status `qualified` while the older script silently ignored the new pending criterion. That violates the fail-closed intent of the production release gate.

## Fix

`scripts/reencryption-release-gate.mjs` now verifies exact own-key sets for the root, `backupPolicy` and `checks`, before checking the values. A future criterion, optional override, missing field, or unsupported schema extension blocks a stable publication until the validator is explicitly updated and independently qualified. It does **not** change either the backup topology or what counts as satisfying any existing check.

`tests/feasibility/local-release.test.mjs` adds regression cases for an unknown root field, additional backup policy, new pending check, new passed check, and missing known check. Each is rejected, even if all seven original checks are marked `passed` and the overall status says `qualified`. The existing **exact** approved schema still passes when a *synthetic* test input marks every required check passed; the checked-in manifest stays `blocked`. This is a shape validation, **not evidence that any pending migration criterion has been met**.

## Non-goals and remaining gates

- The schema guard does not prove physical power-loss durability, OS-wide external writer fencing, transactional Settings/SecretStorage/Source/Shadow/WAL/GitHub updates, stale-client safety or native cross-platform acceptance.
- It does not authorize running `release:local` or changing the checked-in gate status; that command can mutate GitHub release state and is deliberately not invoked by this experiment.
- The manifest itself remains a maintainer acceptance declaration, not an independent attestation, so a malicious or negligent actor able to change all checks still needs separate review/qualification governance.

D152 is small production-path hardening independent of the unresolved native/crash-safety architecture choice.
