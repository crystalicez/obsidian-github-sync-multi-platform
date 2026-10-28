# D149 — Windows process-crash matrix of Node.js fixed-file Selector candidates

Date: 2026-10-29. Owner chose **A**: Node.js primary, strict crash-safe Re-encryption. Wizard **Preview-only**, release gate `blocked`. No Native Helper, GitHub Actions or production writes.

## Actual evidence

`tests/recovery/reencryption-selector-fixed-slots-process-kill.test.ts` invokes an **independent Windows Node process** running the isolated `tests/recovery/support/reencryption-fixed-slot-process-kill-child.mjs`. The child opens one of two pre-existing disposable slots with `O_RDWR | O_DSYNC`, performs real `ftruncateSync`/`writeSync`/`fsyncSync`, then **kills itself via SIGKILL with the target file still open**. A distinct checkpoint file records the precise synchronous stage completed; throwing a child exception is not treated as a successful crash-stop.

The parent examines actual bytes after child exit; each case checks both slot paths still have the original inode and no temporary slot rename. It uses the existing D146 authenticated AES-GCM Selector **test vector** with exact expected identity + WAL generation. Neither the writer nor the reader has any production local-cutover/Sync/GitHub authority.

## Measured 12 Windows crash windows

| Killed writer target | Before open | After open | After truncate | After partial write | After full write (before explicit fsync) | After fsync |
| --- | --- | --- | --- | --- | --- | --- |
| Empty spare slot B; valid old A | authenticated-uncommitted | authenticated-uncommitted | authenticated-uncommitted | **manual recovery** | **manual recovery** (two valid records) | **manual recovery** |
| Existing valid slot A; spare B empty | authenticated-uncommitted | authenticated-uncommitted | **manual recovery** | **manual recovery** | authenticated-uncommitted | authenticated-uncommitted |

Focused result **1/1 test, all 12 deterministic subprocess windows passed**. Fully authenticated ciphertext can already be reopened **before explicit `FileHandle.sync`**; this proves nothing about power-loss durability, especially when `O_DSYNC` already maps to Windows write-through. The observation `authenticated-uncommitted` means **only matching encrypted bytes** and never grants cutover.

## Hard limits

- **Spare-slot ambiguity:** after opening/truncating an empty spare slot, the old valid slot still appears exactly as if no new write ever started. Reading the previous version does **not** rule out an interrupted new generation. Independently durable intent/generation and cross-store transaction evidence are required.
- **In-place rewrite damage:** a killed active-slot writer can erase/tear the only valid record. Manual recovery is safe from false automation, but not proof of automatically recoverable migration.
- **Namespace creation:** initial slot and parent-directory entries still lack a demonstrated physical durability barrier on this Windows Node-only host (D147 directory `fsync` refused).
- **Power loss:** `SIGKILL` terminates the process; it does not disable kernel caches, filesystem or disk/controller power. File readback after process kill cannot certify sudden-power-loss survival.
- **Cross-store durability:** this does not prove atomicity across Obsidian Settings, SecretStorage, original Source Index, separate Shadow Index, WAL, GitHub refs or an independent OS-wide Vault editor fence.

Keep D148/D149 candidate **test-only**. No authoritative Selector writer, new passphrase activation, old passphrase cleanup, automatic rollback/Sync, GitHub mutation, Wizard enablement or Native Helper. Physical power-loss and pre-provisioning persistence qualification remain necessary before considering production.
