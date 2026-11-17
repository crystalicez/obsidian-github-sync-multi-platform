# V4 Windows / Android Qualification Procedure

Date: 2026-07-30 (Asia/Bangkok)

This document separates automated/source evidence from physical-device evidence. A model, virtual stream, or desktop implementation review is **not** a physical 5 GiB pass.

## Current writer capability warning (reviewed 2026-11-09)

The historical 5 GiB procedure below is **NOT currently executable as a supported new encrypted GitHub REST write**. The V4 writer permits at most **8 MiB of ciphertext per newly created Git Blob**, with a smaller encrypted plaintext part after overhead, and applies a **400 content-mutation budget to the part-size selection of each logical file**. A single 5 GiB file would require more than 400 new parts. This selector is **not** evidence that multi-file Sync revisions are globally capped at 400 REST writes; aggregate request pacing/secondary-rate handling needs separate qualification. The historical **48 MiB** part format remains readable, but not newly writable via the REST Blob path. Offline virtual 5 GiB tests do not prove a live 5 GiB push.

Do not run the 5 GiB Force Push instructions on any repository or promote 5 GiB new-write support until the API/mutation limits are redesigned, reviewed and qualified. Use a **separately approved disposable repository** and supported-size files for actual live qualification.

## Status before physical qualification

| Platform | Small-file V4 | Bounded local read | Bounded stage append | Final stage commit | Public 5 GiB claim |
| --- | --- | --- | --- | --- | --- |
| Windows desktop implementation | automated coverage | implemented via desktop path + Node file I/O | implemented | implemented with backup/swap/verify | **unsupported as a new 5 GiB write under current 8 MiB REST object / 400 mutation policy** |
| Android/mobile implementation | existing normal-size path | **not available in the current supported path** | feature-detected `appendBinary` only | not implemented as a bounded atomic stage commit | **disabled / capability-gated** |

The whole-buffer compatibility ceiling is 32 MiB. Large mobile upload must fail with a bounded-I/O capability error rather than allocate the whole logical file.

### 2026-11-09 D363 Mobile capability-gated Re-encryption policy and separate Sync acceptance

Owner selected **A**. On Mobile, every **included** file must be no larger than 32 MiB before Migration can begin. The Wizard's read-only Preview checks physical adapter `list/stat` metadata before GitHub Source verification. The internal one-way Sync-fence entrypoint repeats this check **before** Sync reservation or any persisted fence write. Files excluded by the captured Sync scope do not count. This is not an authenticated full-file parity proof and does not authorize Execute or Cutover. Desktop may initiate with larger files subject to the separate writer and device requirements.

**D364 read-only Source-inventory hardening:** Mobile Wizard Source verification now requests the authenticated per-file records from the immutable pinned GitHub commit (not just totals). It repeats physical DataAdapter list/stat preflight and compares each included path and byte size against authenticated records. A remote-only oversized file, missing included local file, unexpected local file, Source size mismatch, case-folded collision or changed source-record metadata refuses Preview with no permission to publish, no local content allocation, and no one-way Sync fence. The pre-fence Runtime retains its separate physical size check; it does not trust earlier Wizard observations. This is only metadata eligibility and **not** a substitute for a leased double-pass SHA-256 parity proof before any actual Migration.

**Offline negative evidence:** D363 normal Mobile Sync content-source test simulates a 32 MiB + 1 byte file. `createV4ContentSource` asks for bounded read, `V4PlatformIo` reports `boundedRead:false`, and the request rejects without allocating via `DataAdapter.readBinary()`. This is a **known ordinary-Mobile-Sync large-file blocker**, not a pass or device acceptance. Large-file downloads additionally need independent staged commit/recovery verification.

**Required physical Android and iOS acceptance before promoting the Mobile gate:** On isolated disposable vaults only, capture plugin version, Obsidian version, memory/device evidence, and local/remote SHA-256. Verify included 32 MiB exactly is eligible for initiation preview; included 32 MiB + 1 byte blocks with actionable Desktop guidance and no Sync pause/GitHub mutation; an excluded oversized file does not block; changes during metadata enumeration invalidate preview; ordinary small-file Sync continues. **Separately** exercise ordinary Sync of a supported-size large fixture (>32 MiB) both upload and download, including restart/storage pressure, bounded memory, no partial final notes, repeatable SHA-256 and actual remote Git ref/readback in an explicitly approved disposable repository. Until that succeeds, **do not claim Mobile large-file Sync support**. Do not run these live tests against a user's real vault or repo and do not mark the release gate passed based on offline tests.


## Recorded Windows automated evidence

The official Windows Task 15 automated gate has been run against source commit `233c0681afe6869464252d56309b8dff00f538f4` and passed: build, fast `345/345`, repeat `345/345 × 10`, recovery `30/30`, resource `11/11`, feasibility `6/6`, package validation, and the separate 2 GiB + 5 GiB cryptographic virtual soak.

This closes the automated Windows portion of Task 15 only. It does **not** change the physical 5 GiB status below, and it does not satisfy the disposable-repository GitHub measurement required by the operational model.

## Safety rules for physical tests

- Use a disposable vault and a disposable private repository/branch.
- Never point Force Push / Force Pull qualification at a real notes repository.
- Keep at least 12 GiB of free local space for a 5 GiB round trip plus staging/backup headroom.
- Record plugin source commit/archive hash, Obsidian version, plugin version, OS/device, available RAM, and free disk before the run.
- Do not call a result a pass if any stage was simulated, skipped, or replaced by model evidence.

## Historical Windows 5 GiB procedure — new REST upload currently unsupported

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

### 2. Encrypted Force Push — BLOCKED for the historical 5 GiB write

1. Historical instructions only. For any future live qualification, use an approved disposable repository/branch and encrypted mode; do not use this 5 GiB upload size.
2. Do **not** run Force Push for 5 GiB on the current REST writer. Its 8 MiB ciphertext-object ceiling plus the per-file 400 content-mutation selection budget cannot support the requested single-file revision; instead assert an offline bounded-policy refusal.
3. Record start/end wall time.
4. In the Obsidian developer console, capture the in-memory GitHub transport counters after the run:

```js
app.plugins.plugins["encrypted-github-sync-multi-platform"].githubClient.transportMetricsSnapshot
```

5. Record process peak memory using Windows Task Manager / Resource Monitor or a repeatable profiler. Record the measurement method; do not mix RSS/private-working-set/JS-heap labels.
6. For a future separately approved **supported-size** remote write, record the actual observed part count and byte size. The old 107 × 48 MiB legacy layout describes a readable historical format, **not the newly writable GitHub REST policy**.

### 3. No-op sync (only following an approved supported-size upload)

Run one normal sync without changing the file. It must not upload a new content revision. Record request/mutation deltas.

### 4. Force Pull into a clean vault (historical read validation / approved supported-size test only)

Use a second clean disposable vault configured to the same encrypted repository. Force Pull and compute:

```powershell
Get-FileHash -Algorithm SHA256 .\qualification-5gib.bin
```

The SHA-256 must exactly match the source hash.

### 5. Controlled interruption / recovery (approved supported-size test only)

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
