# D226. Preserve secrets during fenced plugin startup

Date: 2026-11-01. Scope: the installed `FastSync.onload` startup path, legacy secret migration, and persisted plugin Settings. Re-encryption remains Preview-only.

## Why startup needed another fence check

D225 blocked the normal Settings Save path. It did not cover `FastSync.onload`, which runs `loadSettings`, calls `migrateV4Secrets`, and may call `persistData` **before** constructing `V4PluginRuntime`.

Legacy Settings can contain plaintext credentials alongside existing SecretStorage IDs. `migrateV4Secrets` writes the legacy value to that ID. When a Re-encryption Sync Fence is present after a crash, this write can replace the old passphrase required for Manual Recovery. The following plugin-data write can also change Settings during recovery.

## Change

- `FastSync.canMigrateStartupSecrets` checks the actual Obsidian vault adapter, plugin directory, and the shared D173 fence-root and marker policy before allowing any legacy migration. A missing, swapped, unreadable, or fenced adapter returns `false`. It does not use the in-memory runtime fallback.
- `hydrateV4SecretsReadOnly` first reads the existing SecretStorage ID, then falls back to legacy plaintext only when no stored value exists. It neither allocates IDs nor calls `setSecret`. This keeps an old key visible in runtime recovery state even if stale legacy plaintext disagrees with it.
- `onload` checks the physical fence again before persisting migrated plugin data. If the check no longer passes, it leaves the original plugin-data file intact. This second check does not claim an atomic cross-process transaction.
- When the fence is clearly absent, the existing secret migration and sanitizing Settings persistence continue.

## Behavioral evidence

`tests/v4/settings-secrets.test.ts` drives the actual `FastSync.onload` entry point with an Obsidian DataAdapter, existing old SecretStorage values, and legacy Settings that disagree with them. Before the fix, the root-only fence case failed because startup mutated the persisted migration state. After the fix, the test rejects all credential and plugin-data writes for root-only, marker-only, complete, and inaccessible fences. It also checks read-only hydration for modern SecretStorage-backed Settings, and confirms that an unfenced startup still migrates.

Focused Red: 63 passed, 1 failed. Focused Green after the initial change: 64 passed, 0 failed. The final full quality gate results are recorded in `HANDOFF-NEXT-SESSION.md`.

## Scope and limits

This is a best-effort, fail-closed **startup** guard. It cannot stop a noncooperating process from writing the same data or make separate SecretStorage and plugin-data operations power-loss atomic. A fence created between a successful check and a later write remains a cross-process race. D225 protects the running Settings Save; D226 adds the pre-runtime startup boundary.

This change does not enable Cutover, delete Source or Backup, clear either passphrase, authorize Sync Resume, change Git refs, or relax any Re-encryption release check. The current release gate remains blocked until authenticated committed Cutover, restart reconciliation, stale-device safeguards, and installed Desktop and Mobile acceptance are proven.
