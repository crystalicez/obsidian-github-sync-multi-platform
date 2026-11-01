# D222 — Manual Recovery triage for actual interrupted Re-encryption evidence

Date: 2026-11-01. Scope: read-only operator guidance and Wizard Preview, not an executable migration. The first-public-release Re-encryption gate remains **blocked**.

## Why this advances release safety

The installed Wizard already explained the general Manual Recovery rules, but did not distinguish a partially written Receipt/Selector, a cryptographically linked yet explicitly **uncommitted** D182 test pair, a historically authentic test pair with *unverified current Git*, and an interrupted Settings/Index switch.

A misleading generic message could encourage a user to infer that a matching pair is a committed Cutover or that old keys are safe to delete. D222 adds a typed, evidence-derived classification to make these situations distinguishable without expanding the ability to mutate data.

## Implementation

New `src/lib/v4/reencryption-manual-recovery-triage.ts`:

- `classifyV4ReencryptionManualRecovery(localD184, currentD221OrNull)` is **pure and read-only**. It works with the actual D184 post-crash artifact window, Settings/active Index selection and cryptographic pairing evidence, plus an *optional* D221 two-full-scan current Backup+Destination report.
- Six mutually exclusive conditions:
  1. `source-prepared-only`: Source settings/index intact and there is no Receipt/Selector pair.
  2. `partial-local-artifacts`: proposed directory, Receipt or Selector written alone or torn, with original Source still selected.
  3. `linked-test-pair-current-git-verified-uncommitted`: D184 pair authenticates and independently obtained D221 full current old-key frozen Backup/new-key Destination contents are verified. **This is not a Commit.**
  4. `linked-test-pair-current-git-unverified`: D184 historical pair authenticates but full current Git evidence is missing or mismatched.
  5. `partial-local-selection`: Settings or Index no longer matches original Source, including both appearing to select Destination. **Not a Commit.**
  6. `unknown-or-corrupt-evidence`: WAL/Fence/crypto/Settings observations cannot be trusted or are incomplete.
- All conditions return `observation: manual-recovery-required`, `liveRecoveryAuthorized: false` and hardcoded `false` for local Cutover, Resume Sync, rollback, Git writes and old-passphrase cleanup. No endpoint takes credentials, opens files or sends requests. A caller-supplied report is never an authorization certificate.
- Every condition has a localized-in-code (currently English) heading, explanation and safe next operator review: preserve the Vault, WAL, Intent, both Secrets and all three branches; do not delete, force-push, automatically retry or resume.
- `V4_MANUAL_RECOVERY_PREVIEW_CONDITIONS` is an explicit data-driven *illustrative* list. The installed `src/views/reencryption-wizard.ts` **Run (Preview)** page displays these examples with a prominent `not a live scan` warning. It does **not** read current Vault storage/Settings/SecretStorage/WAL or GitHub, and it does not imply an actual migration occurred. Execution and Finish remain blocked.

## Behavioral verification

New `tests/v4/reencryption-manual-recovery-triage.test.ts` asserts every individual condition and a **1,008-input crash-window × Settings/Index × pair-evidence × current-Git-status** matrix. Every resulting object is explicitly checked for all forbidden mutations and Manual Recovery outcome. Forged D221 success fields cannot elevate a report with missing proof; a destination-looking pair of Settings+Index is still a partially switched state.

`tests/v4/reencryption-wizard-ui.test.ts` verifies all Preview scenario headings are visible, labels explicitly disclose that no live evidence was inspected, neither settings nor credentials are exposed or altered, and no GitHub request executes merely by opening the Run page.

`tests/v4/reencryption-destination-exact-commit.test.ts` exercises genuine existing D179/D184 AES-GCM persisted Receipt/Selector and D217/D221 complete Backup+Destination readbacks. With a real authenticated linked pair and current Git proven, the triage explicitly reports **verified but uncommitted**. When the pinned Backup Git ref is subsequently moved, the *same* historical pair becomes **current Git unverified**, and no local writes, Cutover or Resume are permitted.

## Limits and remaining work

This does not implement the first genuine authoritative committed Receipt/Selector or a durable transaction point. The tests do not simulate actual OS power loss; no live Windows/macOS/Linux/Android/iOS Obsidian migration was performed. A cooperative lease cannot fence external processes or Git writers. The Preview must not be marketed as live Recovery.

To release Re-encryption: complete the committed Cutover transaction and best-effort Settings/SecretStorage/active Index switch/reconciliation after Restart; prove stale old-key client behavior; ship real active Recovery UI/status under a validated data boundary; test with installed Obsidian Desktop/Mobile. Keep the pinned frozen Backup, separately writable old Source and zero-parent new encrypted Destination, plus old Git history and old passphrase. Do not turn on the gate or Wizard Run based on D222.
