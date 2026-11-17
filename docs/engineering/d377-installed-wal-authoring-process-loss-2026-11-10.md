# D377 — Installed Desktop WAL authoring and simulated process-loss evidence

Date: 2026-11-10. Scope: dirty isolated D87 audit worktree. **Not production release approval.**

## Boundary under test

The released **installed** Obsidian Desktop plugin's `V4PluginRuntime` arms
its persisted Sync Fence on an otherwise unconfigured disposable Vault, then
opens the **actual production** `openNewReencryptionDesktopWalForArmedRun()`
OS-exclusive WAL writer. The authoring code writes a synthetic AES-GCM
generation-1 initial journal slot followed by a generation-2 **pending Backup
Git ref intent**, without ever issuing a GitHub request.

The synthetic test gives the Runtime a no-op initiating-lease callback and
in-memory synthetic Source settings; it does **not** prove the real installed
exclusive migration lease, authenticated GitHub Source, or completed Cutover.
Those checks must remain pending.

Test-only files:
- `scripts/native-installed-wal-writer-probe.ts`: journal authoring and
  independently pinned cryptographic readback, never bundled in `main.js`.
- `scripts/run-obsidian-disposable-wal-authoring.mjs`: isolated Obsidian
  profile, Vault identity validation, install compiled plugin, injected test
  fixture, real process restart, independent slot hashes and cleanup.

## Positive installed runs

| Scenario | Command | Evidence |
| --- | --- | --- |
| Ordinary installed writer release and restart | `node scripts/run-obsidian-disposable-wal-authoring.mjs` | **PASS** (process `c49ce4be-d881-4015-a89f-6f63fde61120`, Exit 0) |
| Process killed while still holding the WAL lock | `node scripts/run-obsidian-disposable-wal-authoring.mjs --kill-writer` | **PASS** (process `21c4dcf4-a079-45c0-a81c-f48932b519fc`, Exit 0) |

Both runs independently confirmed: Sync Fence persisted, two encrypted WAL
slots authenticate with the pinned run/old-key test vector after a **fresh
Obsidian process**, the interrupted Backup ref intent remains pending and
requires remote revalidation, Settings saves are denied, a fresh Runtime
cannot write a new WAL generation, automatic Sync resume and Cutover are
unauthorized, the synthetic plaintext Vault note remains unchanged, no
GitHub token/network publication is configured, and the disposable
Vault/profile are removed.

The process-loss variant keeps the writer FileHandle live with a test-only
renderer reference, observes the physical `.exclusive.lock` before
`taskkill /F` of the **isolated Obsidian process**, and observes that same
stale lock after the fresh process restart. The lock is **not** automatically
reclaimed. The test runner removes the temporary Vault only after terminating
its own test process. This is **NOT** real electrical power-loss/fsync proof.

## Test-harness initialization defect

An early run passed (process `bdf14ec0-be1e-42eb-ab4a-e56dae1c903b`).
Re-runs initially failed intermittently at first start
(`49406cad-18fe-462d-968a-876acfb870bd`) and at restart
(`ed01dcc0-668d-4049-8452-fef74c9fa2cd`), with the physical temporary
Vault cleaned both times. Compared the D377 renderer bootstrap with the
existing proven read-only Desktop smoke: D377 had not waited for the
Obsidian Plugin Manager API to initialize before executing its load helper.
Added a bounded Plugin Manager ready check **before** its single plugin-load
request; normal and interrupted runs then both passed. Do not mistake this
test-startup race for a WAL cryptography failure or a production code fix.

## Other checks and unresolved gates

- Existing installed read-only Recovery smoke process
  `a0301fcb-11f7-4da0-82a2-f30dc99e8566` **PASS** Exit 0, no Github
  and `cleanup:temporary-vault-removed`.
- D244 focused Runtime authoring tests **5/5**, process
  `22220f11-d90b-4251-b17a-2655c74407d1` Exit 0.
- Recovery tests **93/93**, process
  `3d7625af-4f05-4d7b-a00d-cf1fbebb1c6e` Exit 0.
- Maximum Strict TypeScript, JS syntax check, `git diff --check`,
  and `validate:package` passed in the D377 audit worktree.
- **No product code was changed.** These test scripts and this document
  change the earlier D376 Full Fast source fingerprint, so its formal
  `1,615/1,615` run is a **prior snapshot**, not fresh qualification of
  D377. Full Fast must be rerun for a release snapshot.
- `docs/release-gates/reencryption-wizard.json` stays `blocked`.
  No installed Source Git proof, actual backup ref publication, new-key
  vault-object staging, zero-parent Destination publication, Settings/Index
  atomic Cutover, manual other-device reconfiguration or physical
  Android/iOS acceptance was established by this isolated WAL test.

## Local tooling issue

At the start of D377, the `lnwjud` mutation tool rejected a file edit
because its SQLite audit database was near the configured hard limit.
Read-only diagnostics/self-heal plan offered no safe automatic fix; no
audit data, checkpoints or retention settings were deleted/changed.
A later guarded `edit_file` succeeded without configuration changes.
This may recur; do not infer permanent storage capacity was restored.
