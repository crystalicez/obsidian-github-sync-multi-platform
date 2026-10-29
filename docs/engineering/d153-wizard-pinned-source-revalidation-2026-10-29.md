# D153 — Re-encryption Wizard preview branch check binds to verified Source

Date: 2026-10-29. Owner-selected A stays Node.js-first, strict Crash-safe; no Native Helper or GitHub Actions. Re-encryption Wizard remains **Preview-only**, production release gate **blocked**.

## Actual UI issue and fix

The installed-view `V4ReencryptionWizardModal` verifies an encrypted source at one exact pinned Git commit, then separately allows the user to check that proposed Backup and Destination names are unused. Before D153 that second check verified **both absent refs and the physical repository identity** but did *not* reread the Source HEAD or GitHub default branch. If another device had moved the Source, or the default branch changed since the original verification, the UI could still record branch availability as checked using an obsolete verified Source.

The second check now makes three additional **read-only** GitHub GET observations: physical repository identity (existing), actual default branch, and the exact `refs/heads/<source>` Git commit ref (new). All must match the original snapshot, including commit type, full exact SHA and pinned default branch. On disagreement, branch readiness stays unconfirmed and the UI tells the user to return to Preflight and verify Source again. Error text remains sanitized and no passphrase/token appears.

The displayed verified-state description explicitly says the result was valid **at check time only**, not a create-time guarantee or global lock. The Source can still move immediately afterward: future migration execution must independently recheck exact refs before mutation and keep all hard WAL/cutover safety gates. This preview change does **not** authorize publication or make an unsafe cutover safe.

## Real transport simulation regression

`tests/v4/reencryption-wizard-ui.test.ts` exercises the **real Wizard and GitHubClient request transport** under a synthetic Obsidian `setRequestUrlHandler`, not an application-layer mock of the private `scopedClient()`. It tests a stable source, changed Source SHA, changed default branch, unexpected ref name, missing source ref, failed source request, physical repository switch, and a destination collision.

Each network request is asserted to use `GET` and omit a body; source credentials and new passphrase cannot appear in rendered text. Stable evidence sets `checked` only for non-authorizing Preview, while every stale/error case leaves `checked` undefined. Both branch names remain non-existent or the collision is explicitly reported; no GitHub write, local storage, SecretStorage, source/backup branch or Vault mutation occurs.

## Release scope

This is runtime UI integrity hardening, **not** an endorsement that migration can start. The remaining owner-approved strict requirements for a real Cutover include physical crash durable intent/namespace and selector, independent OS-wide Vault writer fencing, Settings/SecretStorage/Index/WAL/GitHub cross-store restart safety, and installed multi-device acceptance. Actual release gate stays `blocked`.
