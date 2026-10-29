# D160 — V4 Sync Runtime non-Error terminal-failure containment

Date: 2026-10-30. Scope: production normal V4 Sync failure handling, not Recovery policy, GitHub publish behavior, or Re-encryption Cutover. No live user Vault, SecretStorage or GitHub writes, no GitHub Actions or Native Helper. The Re-encryption first-public-release gate stays `blocked` and Wizard Preview-only.

## Problem

`V4PluginRuntime.execute()` had a single broad catch for operation errors. It read `(error as Error).message` without a runtime check. The TypeScript assertion does not change runtime values; adapter errors may reject with `null`, strings, plain objects, or an `Error` with an empty message. With `null` or `undefined`, evaluating `.message` throws again **inside** the error handler, before `progressStore.finish("failed")`, so the run may reject and leave the UI lifecycle without the proper terminal failure. Blindly stringifying such values could also echo arbitrary opaque remote payloads or credential-like contents into a user-visible Notice.

## Fix

Keep the existing `V4CancelledError` early return and all specialized `V4OpenEditorConflictError` / `V4ManualRecoveryRequiredError` recovery UI handling. At the terminal catch, use a message only when the value is actually an `Error` carrying a nonempty textual message. Otherwise choose a static safe generic message instructing the user to review Sync status before manually retrying. Both the Progress failed snapshot and user Notice receive the same safe message.

This change does not alter a genuine `Error`'s existing text, the logger's internal failure object, publication/CAS retry decisions, cancellation semantics, or GitHub remote writes. A failure does **not** trigger automatic replay.

## Real runtime regression

`tests/v4/settings-secrets.test.ts` uses the existing actual `V4PluginRuntime`, `V4SyncSession` and in-memory fake GitHub. The fake `createGitBlob` rejects during an actual Force Push upload with `null`, a private credential-like string, an opaque object, and both empty and whitespace-only `Error` messages. Tests verify `failed` terminal lifecycle, `failurePhase: uploading`, a fixed safe status/Notice, no private-value exposure and **no published ref** after failed upload. A separate case proves that genuine nonempty `Error` text remains available in the terminal status and Notice and no remote ref was published.

The fake runtime may attempt multiple distinct blob uploads in parallel; test assertions correctly check that upload reached the injected fault and no ref publication occurred, rather than incorrectly equating total blob calls with the number of CAS attempts. The test is offline.

Focused `pnpm run test:fast --filter=settings-secrets`: **49/49 PASS**.

## Limits

Only non-`Error` and blank-`Error` values receive the static message. This does not claim that arbitrary nonblank `Error.message` from untrusted providers is sanitised; a separate trust-boundary review is appropriate before a general policy change. Nor does this patch prove external writer fencing, WAL directory durability under power loss, a cross-store Cutover transaction or installed cross-platform acceptance.
