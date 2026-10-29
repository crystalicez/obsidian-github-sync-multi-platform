# D158 — Force confirmation client identity and visible inventory revalidation

Date: 2026-10-30. This patch strengthens **normal Sync Force Push / Force Pull** approval. Re-encryption remains **Preview-only** and first-public-release gate stays **blocked** under the owner-approved Node.js-first strict crash-safe policy. No GitHub Actions, Native Helper, live E2E, user vault mutation or release.

## Finding

D157 correctly pinned the displayed owner/repository/branch, credentials, mode and scope to the settings snapshot and invalidated closed Force dialogs. Two gaps remain at a confirmation's actual click time:

1. `FastSync.githubClient` can be reinitialized without changing any persisted configuration text. The dialog could still authorize a destructive operation using a different GitHubClient instance than the one present when the user reviewed the original target. A client-identity guard cannot prove the physical GitHub repository ID, but it prevents silently reusing the *same dialog* after an in-memory connection replacement.
2. The dialog presents a local Vault file count. Without rechecking the Vault's visible file inventory, even large changes after the initial user review would leave that displayed count stale. A **count alone is insufficient**: one file renamed while another was deleted/recreated can leave the total unchanged.

## Narrow implementation

`src/main.ts:showForceConfirm` captures the *object identity* of `githubClient` and a sorted array of visible local file paths, excluding files below the configured Obsidian config directory using the same predicate as the existing displayed count. The displayed count is derived from that exact array.

Immediately before Force dispatch, `stillConfirmed()` now also requires:
- Current GitHubClient instance identity equals the captured instance.
- A fresh sorted visible-path inventory has the same length **and each path matches** the captured array.
- If enumerating the current inventory throws, **fail closed** instead of authorizing a destructive command.

Existing D157 settings Save/draft/material-setting and modal close guards remain. On mismatch the dialog is closed with one generic notice to review the current target and confirm anew; it neither retries nor performs any remote write. Explicitly confirmed unchanged operations still start exactly once.

## Executable proof

`tests/v4/main-ui-sync-errors.test.ts` adds D158 behavioral regression using the actual production Force modal, slider and button callbacks for **both** Force Push and Force Pull. It simulates swapping GitHubClient while preserving all owner/repo/branch/token strings, a visible file count change, a same-count path replacement, and a Vault enumeration error, then verifies **zero** Force executions and only generic nonsecret Notices. A fresh correct client and unchanged path inventory still permits one explicit Force dispatch even after double-click. Focused UI **7/7 passed**.

## Limits

These are **click-time** observations only. They do not hash local file contents, freeze Obsidian/editor buffers, prevent external writers, validate GitHub's physical repository identity or guarantee remote HEAD immutability. Full Sync publication/recovery/CAS/WAL behavior is unchanged. No claims of physical power-cut durability or Re-encryption Cutover readiness follow from this patch.
