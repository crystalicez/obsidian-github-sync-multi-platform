# V4 Windows / Android Qualification Procedure

Date: 2026-07-30 (Asia/Bangkok)

This document separates automated/source evidence from physical-device evidence. A model, virtual stream, or desktop implementation review is **not** a physical 5 GiB pass.

## Status before physical qualification

| Platform | Small-file V4 | Bounded local read | Bounded stage append | Final stage commit | Public 5 GiB claim |
| --- | --- | --- | --- | --- | --- |
| Windows desktop implementation | automated coverage | implemented via desktop path + Node file I/O | implemented | implemented with backup/swap/verify | **pending physical test** |
| Android/mobile implementation | existing normal-size path | **not available in the current supported path** | feature-detected `appendBinary` only | not implemented as a bounded atomic stage commit | **disabled / capability-gated** |

The whole-buffer compatibility ceiling is 32 MiB. Large mobile upload must fail with a bounded-I/O capability error rather than allocate the whole logical file.

## Recorded Windows automated evidence

The official Windows Task 15 automated gate has been run against source commit `233c0681afe6869464252d56309b8dff00f538f4` and passed: build, fast `345/345`, repeat `345/345 × 10`, recovery `30/30`, resource `11/11`, feasibility `6/6`, package validation, and the separate 2 GiB + 5 GiB cryptographic virtual soak.

This closes the automated Windows portion of Task 15 only. It does **not** change the physical 5 GiB status below, and it does not satisfy the disposable-repository GitHub measurement required by the operational model.

## Safety rules for physical tests

- Use a disposable vault and a disposable private repository/branch.
- Never point Force Push / Force Pull qualification at a real notes repository.
- Keep at least 12 GiB of free local space for a 5 GiB round trip plus staging/backup headroom.
- Record plugin source commit/archive hash, Obsidian version, plugin version, OS/device, available RAM, and free disk before the run.
- Do not call a result a pass if any stage was simulated, skipped, or replaced by model evidence.

## Windows 5 GiB qualification

### 1. Generate deterministic content without a 5 GiB in-memory allocation

PowerShell example (writes one reusable 8 MiB block repeatedly):

```powershell
$Path = Join-Path $pwd "qualification-5gib.bin"
$Total = 5GB
$BlockSize = 8MB
$buffer = New-Object byte[] $BlockSize
for ($i = 0; $i -lt $buffer.Length; $i++) { $buffer[$i] = [byte](($i * 31 + 17) -band 255) }
$stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
try {
  $written = 0L
  while ($written -lt $Total) {
    $count = [Math]::Min($buffer.Length, $Total - $written)
    $stream.Write($buffer, 0, [int]$count)
    $written += $count
  }
} finally { $stream.Dispose() }
Get-FileHash -Algorithm SHA256 $Path
```

Record the source SHA-256.

### 2. Encrypted Force Push

1. Configure the disposable repository/branch and encrypted mode.
2. Run Force Push.
3. Record start/end wall time.
4. In the Obsidian developer console, capture the in-memory GitHub transport counters after the run:

```js
app.plugins.plugins["encrypted-github-sync-multi-platform"].githubClient.transportMetricsSnapshot
```

5. Record process peak memory using Windows Task Manager / Resource Monitor or a repeatable profiler. Record the measurement method; do not mix RSS/private-working-set/JS-heap labels.
6. Record the writer part count and part size observed in the repository. For the current 48 MiB policy, a 5 GiB logical file is expected to use 107 parts, but the observed value is the qualification evidence.

### 3. No-op sync

Run one normal sync without changing the file. It must not upload a new content revision. Record request/mutation deltas.

### 4. Force Pull into a clean vault

Use a second clean disposable vault configured to the same encrypted repository. Force Pull and compute:

```powershell
Get-FileHash -Algorithm SHA256 .\qualification-5gib.bin
```

The SHA-256 must exactly match the source hash.

### 5. Controlled interruption / recovery

Repeat with a fresh generated file/revision. Interrupt Obsidian only after a durable phase that the UI/logs make observable (for example after publication begins); restart and allow recovery/replan to finish. Verify:

- no half-written final target,
- no silent user edit overwrite,
- local index does not claim an unverified remote head,
- rerunning recovery/sync is idempotent,
- final SHA-256 matches the chosen published version.

Do not intentionally corrupt the real repository to test ambiguous publication; automated recovery tests cover lost-response and reachability states deterministically.

## Android qualification gate

Current source intentionally does **not** expose a bounded mobile read path. Therefore Android 5 GiB qualification is blocked before the physical round trip starts.

A future Android 5 GiB claim requires all of the following on the target runtime:

1. supported bounded local read,
2. bounded staging write,
3. bounded final commit/replace semantics,
4. full generated 5 GiB encrypted push → clean-vault pull → SHA-256 equality,
5. controlled interruption/recovery,
6. peak-memory measurement that stays within the selected device envelope.

Until then, record Android large-file status as `platform-capability-fail`, not `technical-pass`.

## Evidence record

Update `tests/baselines/v4/windows.json` or `android.json` only with observed values. Use `null` for unmeasured values; never copy model values into physical fields.
