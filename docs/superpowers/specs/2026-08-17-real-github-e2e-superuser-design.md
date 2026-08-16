# Real GitHub E2E Superuser Design

Date: 2026-08-17 (Asia/Bangkok)

## Goal

Turn the existing destructive real-GitHub smoke test into a deterministic release gate that behaves like one physical machine hosting two independent logical Obsidian devices against the same disposable GitHub branch. Cover realistic power-user behavior and real remote interference without introducing random chaos or multi-gigabyte workloads.

## Scope

The E2E continues to use the real GitHub REST API and a dedicated non-default branch. One test process creates independent Device A and Device B state: separate in-memory vaults, local indexes, device IDs, GitHub clients, and sync sessions, while both clients point at the same repository and branch.

The suite must remain deterministic. Concurrency is allowed only where the harness controls the interference point. Do not add random sleeps, fuzzing, or probabilistic races to the release gate.

The suite is still a small/medium network smoke workload. It does not claim 5 GiB qualification, pack-scale qualification, or physical-device qualification.

## Scenario Matrix

### 1. Single-device baseline, both storage modes

Preserve the current plaintext and encrypted force-push -> no-op -> history -> clean-vault force-pull round trip, binary Contents-vs-Git-Blob validation, encrypted opaque-path assertions, and final branch cleanup.

Add realistic path/content fixtures to both modes:

- Unicode and emoji: `Notes/สวัสดี 🌏/mañana.md`
- spaces and punctuation: `Projects/2026 Q3/[draft] #1.md`
- dotfile-style user content: `.workspace/user-state.json`
- empty file: `Empty/zero-byte.bin`
- medium binary content around 1 MiB to exercise nontrivial binary transport without becoming a large-file benchmark

### 2. Two-device stale catch-up

Device A publishes an initial remote state. Device B starts from an independent empty local index and force-pulls that state. A then changes multiple disjoint paths and publishes again while B remains stale. B performs a normal sync and must catch up without losing its own untouched local files or creating unnecessary conflict copies.

### 3. Same-file concurrent edit with conflict preservation

A and B share the same base. Both edit the same Markdown file differently. A publishes first. B then syncs using the `copy` conflict policy. The result must preserve B's local edit at the canonical path and preserve A's remote edit in a deterministic conflict-copy path containing `.conflict-remote-device-b-`. A subsequent clean Device C force-pull must reproduce both files byte-for-byte from the remote state.

### 4. Rename versus stale edit

A and B share the same base file identity. A renames the file and publishes. B, still stale, edits the old path and syncs. The suite must verify that no file content disappears silently, remote metadata remains readable, and a subsequent clean pull produces a self-consistent state. For encrypted mode, surviving rename identity must keep the original stable `fileId`/opaque remote path for the renamed lineage.

### 5. Delete then recreate same path

A deletes a tracked file and publishes. A recreates the same logical path with different bytes and publishes again. The recreated file must have a different identity from the deleted generation. B, which was stale across the delete/recreate window, must catch up to the new generation without reusing the old file identity.

### 6. Binary overwrite across devices

A and B share a binary file. A publishes one binary revision, B later publishes a different binary revision after catching up. A normal-syncs again and must receive exactly B's bytes. For encrypted mode, every path-based encrypted object read used for verification must match the canonical Git Blob bytes.

### 7. Controlled branch-head race

The test harness may arm a one-shot remote interference hook. Immediately before one targeted plugin ref update is forwarded to GitHub, the harness creates and publishes a valid external commit on the same disposable branch. This must make the plugin's candidate publication observe a branch-head mismatch instead of silently overwriting the external commit.

The release gate requires deterministic evidence that:

- the injected external commit becomes reachable,
- the plugin detects the branch-head change,
- no force update is used,
- rerunning sync/replan from the observed head succeeds or fails with the documented explicit replan error rather than losing data,
- final branch history retains the external commit.

If the current production session intentionally surfaces the branch-head-change error to its coordinator rather than retrying internally, the E2E should assert that contract and then explicitly rerun the session.

## Harness Architecture

Refactor `tests/github-e2e/v4-real-github-e2e.test.ts` into small test helpers rather than one monolithic round-trip body:

- `DeviceContext`: logical name, `MemoryVault`, `V4LocalIndex`, `GitHubClient`, `V4SyncSession`, and optional run state.
- `createDevice(...)`: constructs a fully independent logical device using the shared remote configuration/keyring.
- `forcePullFreshDevice(...)`: creates a new device and mirrors the current remote state for convergence assertions.
- byte helpers for deterministic text/binary fixtures.
- remote verification helpers for branch head, tree paths, encrypted object-vs-blob equality, and history reachability.
- a one-shot request bridge interference controller for the controlled race only.

Keep the request bridge global because the Obsidian test stub exposes one global `requestUrl` handler. Device independence comes from separate clients and indexes, not separate handlers.

## Safety

- Reject protected-looking branches exactly as today.
- Delete/reset only the configured disposable E2E branch.
- Preserve `after()` cleanup and verify branch absence.
- Never log token, passphrase, logical file contents, or encrypted payload bytes.
- Metrics may include mode/scenario, elapsed time, counts, byte totals, retries, pacing/cooldown, unknown outcomes, and status classes.
- Controlled remote interference must only write to the configured disposable branch and must never force-update it.

## Runtime and Reliability

Target one real-GitHub quick run that stays practical for manual release qualification. Prefer multiple scenarios inside a single initialized branch lifecycle where safe, but reset between scenarios that depend on a clean history or exact identity baseline. Avoid 50+ MiB objects, thousands of files, and arbitrary concurrency.

Each scenario logs a compact safe metric line so a slow or retry-heavy case can be identified. A failing scenario must identify its scenario name in the assertion/error context.

## Release 1.0.8

After the enhanced E2E harness compiles and the repository CI gate is green, align release metadata to 1.0.8:

- `package.json`: `1.0.8`
- `manifest.json`: `1.0.8`
- `versions.json`: add `"1.0.8": "1.11.4"`

Do not create a 1.0.7 tag retroactively. The release workflow should create the 1.0.8 release from the tested master commit when the version bump lands.

## Success Criteria

- Existing deterministic CI suites remain green.
- `GITHUB_E2E_COMPILE_ONLY=1 pnpm test:github-e2e:quick` compiles the expanded harness.
- A configured real-GitHub run exercises both logical devices and all scenario groups above against one disposable branch with verified cleanup.
- Controlled branch interference never force-updates or loses the injected commit.
- Release metadata is consistently 1.0.8 and package validation passes.
- All code and docs are pushed to GitHub; `master` is the source of truth.