# V4 Windows / Android Qualification Procedure

Originally drafted: 2026-07-30 (Asia/Bangkok). Windows physical release scope updated by maintainer decision: 2026-10-18.

This document separates automated/source evidence from physical-device evidence. **For the current release, the Windows physical large-file test is capped at 100 MB (100,000,000 bytes, decimal), not 5 GiB.** Historical virtual 2 GiB/5 GiB tests remain automated evidence, not a physical-device pass or a release requirement.

## Status before physical qualification

| Platform | Small-file V4 | Bounded local read | Bounded stage append | Final stage commit | Current release physical-file test / support claim |
| --- | --- | --- | --- | --- | --- |
| Windows desktop implementation | automated coverage | implemented via desktop path + Node file I/O | implemented | implemented with backup/swap/verify | **100 MB test pending; no physical >100 MB claim** |
| Android/mobile implementation | existing normal-size path | **not available in the current supported path** | feature-detected `appendBinary` only | not implemented as a bounded atomic stage commit | **No large-file release claim; capability-gated** |

The whole-buffer compatibility ceiling is 32 MiB. Large mobile upload must fail with a bounded-I/O capability error rather than allocate the whole logical file.

## Recorded Windows automated evidence

The official Windows Task 15 automated gate has been run against source commit `233c0681afe6869464252d56309b8dff00f538f4` and passed: build, fast `345/345`, repeat `345/345 × 10`, recovery `30/30`, resource `11/11`, feasibility `6/6`, package validation, and the separate 2 GiB + 5 GiB cryptographic virtual soak.

This closes the historical automated Windows portion of Task 15 only. It does **not** prove the new physical 100 MB round trip. The 5 GiB operational model remains historical background, not a blocker for this release.

## Safety rules for physical tests

- Use a disposable vault and a disposable private repository/branch.
- Never point Force Push / Force Pull qualification at a real notes repository.
- Keep at least 1 GiB of free local space for the 100 MB round trip plus staging/backup headroom, and record the actual free space.
- Record plugin source commit/archive hash, Obsidian version, plugin version, OS/device, available RAM, and free disk before the run.
- Do not call a result a pass if any stage was simulated, skipped, or replaced by model evidence.

## Windows 100 MB physical qualification (current release)

### 1. Generate exactly 100,000,000 bytes without a full-file in-memory allocation

PowerShell example (writes one reusable 8 MiB block into a new file inside the disposable vault):

```powershell
$Path = Join-Path $pwd "qualification-100mb.bin"
$Total = [int64]100000000
$BlockSize = 8MB
$buffer = New-Object byte[] $BlockSize
for ($i = 0; $i -lt $buffer.Length; $i++) { $buffer[$i] = [byte](($i * 31 + 17) -band 255) }
$stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
try {
  $written = 0L
  while ($written -lt $Total) {
    $count = [Math]::Min($buffer.Length, $Total - $written)
    $stream.Write($buffer, 0, [int]$count)
    $written += $count
  }
} finally { $stream.Dispose() }
if ((Get-Item -LiteralPath $Path).Length -ne $Total) { throw "Test file size mismatch" }
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
6. Record the writer part count and part size observed in the disposable repository. The 100 MB case crosses the 50 MiB chunk threshold; the **observed** part count, not a modeled value, is qualification evidence.

### 3. No-op sync

Run one normal sync without changing the file. It must not upload a new content revision. Record request/mutation deltas.

### 4. Force Pull into a clean vault

Use a second clean disposable vault configured to the same encrypted repository. Force Pull and compute:

```powershell
Get-FileHash -Algorithm SHA256 .\qualification-100mb.bin
```

The SHA-256 must exactly match the source hash.

### 5. Controlled interruption / recovery

Use at most another 100 MB generated file/revision in the disposable environment. Interrupt Obsidian only after a durable phase that the UI/logs make observable (for example after publication begins); restart and allow recovery/replan to finish. Verify:

- no half-written final target,
- no silent user edit overwrite,
- local index does not claim an unverified remote head,
- rerunning recovery/sync is idempotent,
- final SHA-256 matches the chosen published version.

Do not intentionally corrupt the real repository to test ambiguous publication; automated recovery tests cover lost-response and reachability states deterministically.

## Android qualification gate

Current source intentionally does **not** expose a bounded mobile read path. The Windows 100 MB qualification does not authorize an Android large-file support claim. Android large-file transfers remain capability-gated.

A future Android large-file claim requires a separate scope decision and all of the following on the target runtime:

1. supported bounded local read,
2. bounded staging write,
3. bounded final commit/replace semantics,
4. physical encrypted push → clean-vault pull → SHA-256 equality at the separately approved Android size,
5. controlled interruption/recovery,
6. peak-memory measurement that stays within the selected device envelope.

Until then, record Android large-file status as `platform-capability-fail`, not `technical-pass`.

## Evidence record

Update `tests/baselines/v4/windows.json` or `android.json` only with observed values. Use `null` for unmeasured values; never copy model values into physical fields.
