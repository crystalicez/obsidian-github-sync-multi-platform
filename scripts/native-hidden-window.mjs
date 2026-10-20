import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

export function parseNativeHiddenIdleMs(value, nativeNotes) {
  if (value === undefined) return 0;
  const milliseconds = Number(value);
  assert.ok(nativeNotes > 0, "Native hidden-window qualification requires bulk notes");
  assert.ok(Number.isSafeInteger(milliseconds) && milliseconds >= 5_000 && milliseconds <= 360_000,
    "Native hidden idle must be between 5,000 and 360,000 ms");
  return milliseconds;
}

export function hideOwnedObsidianWindow({ runId, expectedProfile, spawn = spawnSync, platform = process.platform }) {
  assert.equal(platform, "win32", "Native hidden-window qualification requires Windows");
  assert.match(runId, /^[0-9a-f]{16}$/u, "Expected random, 16-digit hexadecimal test-run identifier");
  assert.ok(typeof expectedProfile === "string" && expectedProfile.includes(runId)
    && expectedProfile.includes("obsidian-live-github-e2e"), "Refusing to target non-synthetic Obsidian profile");
  // Powershell looks up the *freshly generated profile*, then refuses to touch any
  // process if the owned test window is not unique. The run ID contains only hex.
  const escapedProfile = expectedProfile.replaceAll("'", "''");
  const command = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -Namespace NativeHidden -Name Window -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr handle, int command);'",
    `$owned=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Obsidian.exe' -and $_.CommandLine -like '*${runId}*' -and $_.CommandLine.Contains('${escapedProfile}') })`,
    "$handles=@($owned | ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).MainWindowHandle } | Where-Object { $_ -ne [IntPtr]::Zero })",
    'if($handles.Count -ne 1){ throw "Expected exactly one owned synthetic Obsidian window, found $($handles.Count)" }',
    "[NativeHidden.Window]::ShowWindowAsync($handles[0],0) | Out-Null",
    "Write-Output 'SYNTHETIC_OBSIDIAN_MINIMIZED'",
  ].join("; ");
  const result = spawn("powershell", ["-NoProfile", "-Command", command], {
    encoding: "utf8", timeout: 25_000, windowsHide: true, shell: false,
  });
  assert.ok(result.status === 0 && result.stdout?.includes("SYNTHETIC_OBSIDIAN_MINIMIZED"),
    "Unable to minimize uniquely identified synthetic Obsidian window");
}
