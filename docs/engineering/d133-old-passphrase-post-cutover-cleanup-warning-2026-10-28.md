# D133 — Owner-approved old-passphrase cleanup after strictly durable cutover

Date: 2026-10-28. **Policy and Preview-only UX alignment; no active SecretStorage deletion, no real migration, release BLOCKED.**

## Decision

The owner explicitly rejected keeping the OLD passphrase indefinitely after the user has intentionally entered a NEW passphrase and completed Re-encryption. The approved **initiating-device** behavior is:

1. Before the single Review & Confirm, show an unmissable warning: the original Source and frozen Backup refs (and old encrypted Git history) **still require the OLD passphrase**, even after the initiating device uses the NEW passphrase. Encourage the user to save the old passphrase themselves in a secure location if they may want to access the old data later. Do not show the old passphrase itself in text/logs.
2. Use the OLD passphrase only during the migration and any pending **strict crash-safe** recovery, not as a permanent retained key. **Do not clear it before** the verified, restart-safe Branch/Passphrase/Local Index commit; ambiguous or incomplete cutover must preserve both old and new credentials for deterministic reconciliation. This interim requirement is *not* a policy to retain the obsolete key after success.
3. Once the new configuration, new passphrase Secret ID, destination-local index, remote full-content verification, and durable local cutover/commit receipt are all proven safe, **clear the obsolete OLD passphrase from this initiating device's Obsidian SecretStorage automatically**, without a second consent prompt. No auto-deletion of Source/Backup/Destination branches, Git ciphertext/history, or other devices' independently stored passphrases.
4. The cleanup itself must be idempotent and safe on crash/restart, and must not accidentally clear the new passphrase, GitHub token, or a secret ID referenced by currently active settings. If cleanup fails, explain the residual old credential and offer a safe retry only after independently proving cutover success. Never claim secure deletion of OS-backed storage bytes, snapshots, backup copies or caches from a SecretStorage API call: the current abstraction only exposes `setSecret(id, value)`, not a guaranteed cryptographic secure-erase primitive.
5. The existing normal `FastSync.saveSettings()` path can clear superseded Secret IDs following its own settings commit, but this **does NOT prove a full Re-encryption cutover transaction** across Obsidian settings, SecretStorage and sharded index. Do not invoke it as an implicit migration cleanup strategy until all strict independent gates exist.

This D133 owner choice supersedes D132/D131 guidance wherever those notes could be mistaken for a requirement to **keep the old passphrase indefinitely**. Both IDs may temporarily coexist for crash recovery before the commit.

## Implemented in D133

- `src/lib/v4/reencryption-wizard-plan.ts` now carries immutable, secret-free literals `oldPassphraseLocalRetention: "clear-after-proven-durable-cutover"`, `oldPassphraseRequiredForOldBranches:true`, and `oldPassphraseCleanupAuthorized:false`. This is a **future finish policy**, never a permission to delete.
- The read-only Wizard now warns on **Destination & encryption** and **Review & confirm** to save the old passphrase separately before starting. The Finish preview makes post-commit cleanup explicit. There is NO second confirmation, no live GitHub mutation, no SecretStorage call and no local settings/index write.
- Tests are RED→GREEN: the plan's exact expected identity previously lacked these fields, and the UI did not display the old-passphrase warning. The new UI regression additionally tests no plaintext old/new passphrase or GitHub token appears in the review. Preview-only/no-execution rules remain tested.

## Validation

RED→GREEN observed in the exact policy proposal test and new warning UI test before implementation. After implementation: focused Wizard Plan **6/6** and Wizard UI **6/6**, full Fast **953/953**, repeat **10×953/953** (exit 0, zero failures), Recovery **82/82**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, Production Build, GitHub E2E compile-only (3 bundles), metadata/package checks and bounded 100,000,000-byte cryptographic Soak with identical reference SHA-256 ALL PASS. No live GitHub mutation, installed Obsidian qualification or SecretStorage deletion performed.

## Still BLOCKED

A real encrypted WAL local cutover intent + committed/restart-reconciled completion, proof of proper old/new Secret ID lifecycle and cleanup ordering, full GitHub source/destination ref/readback, strict platform durability including Windows directory `fsync EPERM`, and installed cross-platform tests have NOT passed. `docs/release-gates/reencryption-wizard.json` remains `status:blocked`. No Native Helper integrated, no GitHub Actions, no branch deletion, no release permission and no destructive secret operations in this stage.
