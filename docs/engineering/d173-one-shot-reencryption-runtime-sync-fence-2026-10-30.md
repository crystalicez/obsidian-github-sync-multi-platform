# D173 — One-shot Migration Sync Fence wired into V4 Runtime

Date: 2026-10-30. Status: internal infrastructure; Re-encryption Wizard **Preview-only**, release gate **blocked**.

## Why

The D166–D172 best-effort re-encryption stages maintain their own authenticated WAL, remote Backup/Destination receipts, local Intent and prepared encrypted Selector, but none is yet wired into the installed Wizard. V4 Runtime previously had no durable way to recognize a pending local migration and refuse a new Sync. A future migration must pause Sync before it begins writing frozen Backup/Destination or local Cutover artifacts.

## Implementation

New `src/lib/v4/reencryption-sync-fence.ts` contains a tiny platform-neutral, nonsecret, one-shot fence protocol:

- `armV4ReencryptionSyncFence()` is an **internal preflight primitive** that must be called before the first migration mutation, while existing Sync is idle and under the initiating device's cooperative lease. It pins run ID, original Source and new Destination identities in one physical GitHub repository, refuses concurrent same-adapter attempts, creates `github-sync-v4-rekey-sync-fence/` in private plugin data once, writes `active.json` and independently reads the exact bytes back. A lost write acknowledgement is **not retried**. An existing directory, even with no file, is a permanent pause pending Manual Recovery; the API provides no removal method.
- `assertV4ReencryptionSyncFenceClear()` requires **exactly false** from both root and marker exists checks; any true, storage error or malformed adapter result blocks. It deliberately does not parse or trust the nonsecret marker, so torn data cannot unlock Sync.
- `src/lib/v4/runtime.ts` now calls this check in the common V4 `execute()` path before any GitHub network operation, and again before every CAS retry. All automatic/manual/force triggers pass through the same check. Once blocked, the runtime records a failed/blocked status with a recovery-oriented message, disables Obsidian File Watch, does not re-enable it during `finally`, suppresses future local change enqueue and returns `skipped` for subsequent scheduled Sync attempts. Explicit Manual and Force calls continue reporting the reason. The in-memory runtime flag persists until the runtime is recreated; it is **not** a permission to clear the on-disk fence.

A normal Vault with no fence retains original Sync behavior. The one-slot plugin path is independent of source/destination branch and can be checked before loading encrypted keys, GitHub state or WAL.

**Important limits:** This is an **entrypoint gate**, not a cross-process writer fence or atomic migration transaction. It does not stop a Sync that started before the fence appeared. The future Wizard Run must arrange coordinated quiescence and arm the fence **before** all migration mutations. The D170/D172 internal prepared writers are not yet called by the installed Wizard and are **not** automatically guarded by this new primitive. The existing runtime uses the single-segment legacy `github-sync-v4-index` root, while D170/D172 isolated-cutover planners currently require a validated nested root; that storage-contract mapping must be reconciled before connecting the Wizard. Do not claim that all interrupted migrations are detected before integration.

No automatic unarm/cleanup, rollback, old-key deletion, active Selector, SecretStorage/Settings switch or GitHub branch mutation is introduced. The Release Gate remains blocked.

## Verification

- `tests/v4/reencryption-sync-fence.test.ts` tests one-shot fence, clean vault, torn/missing/corrupt marker, unexpected storage return or I/O failure, lost write response with no retry, wrong identities, overlapping attempts, and a **disposable real Windows filesystem** write with lost acknowledgement followed by a fresh filesystem adapter that still blocks.
- `tests/v4/settings-secrets.test.ts` runs real `V4PluginRuntime` against a mocked GitHub with an initialized branch, then introduces a private fence and confirms Manual, Startup, Force Push/Pull cannot perform another GitHub ref/blob call and report a blocked status. Once fenced, Scheduled Sync skips and local file changes cannot enqueue new work. The standard fixture without a fence still reaches GitHub.
- `tests/v4/network-storage-warning.test.ts` now supplies the minimal `exists()` method that a real Obsidian vault adapter offers. This fixes an initial Full Fast regression from an incomplete fake adapter **without** weakening the fence.
- Focused Fence **6/6**, UNC **3/3**, Full Fast **1135/1135**, Recovery, Feasibility, Resource **11/11**, Maximum Strict TypeScript, Build, three GitHub E2E **compile-only** bundles, metadata/package validators and bounded 100,000,000-byte SHA-256 soak all **pass**.

No credentialed live GitHub migration, installed Obsidian acceptance, physical power-cut simulation, release or branch merge was attempted.

## Next blockers

Integrate fence arming into a fully verified Wizard Run prior to migration, with engine-wide in-flight Sync/queue quiescence and an explicit exit/manual recovery policy. Then implement the authoritative separately authenticated committed Selector, Settings/SecretStorage/index Cutover, early Obsidian load Sync gating across platforms, and torn-write restart matrix with actual installed Desktop/Mobile E2E. Source and frozen Backup remain intact. Keep `docs/release-gates/reencryption-wizard.json` `blocked`.
