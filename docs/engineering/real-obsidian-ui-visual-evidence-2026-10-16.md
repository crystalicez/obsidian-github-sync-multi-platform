# Real Obsidian Desktop UI Screenshots — 2026-10-16

## Scope, isolation, and how to rerun

This is **actual Obsidian 1.14.4 Desktop on Windows**, not a mock browser page. The reusable entry point is `scripts/run-ui-screenshots.mjs`, called by `pnpm test:ui:visual`. Obsidian is launched with a separate Electron `--user-data-dir` and a project-local **synthetic** vault registered via that profile's own `obsidian.json`. No personal vault, GitHub PAT, remote repository, encryption secret, or real destructive sync operation is used.

From the repository root, with Obsidian installed at `C:\Program Files\Obsidian\Obsidian.exe`:

```powershell
corepack pnpm test:ui:visual
```

The script runs the real production build, starts a disposable Obsidian instance, checks the **exact synthetic vault path and no-credentials state before invoking any UI actions**, enables Community Plugins only inside that isolated profile, reloads the locally built plugin, exercises Settings and Sync Center, captures screenshots through the Electron CDP connection, and writes `report.json`. **The process it launched is terminated after the test by default**; pass `--keep-open` only when you need to inspect that synthetic instance manually. Attach mode never closes another instance. Each invocation creates a unique synthetic vault, isolated Electron profile, screenshots, and JSON report below ignored `<repo>/.tmp/ui-visual-smoke/runs/<run-id>/`. This avoids overwriting an earlier test run and keeps generated data out of tracked Git history.

For an already-running isolated instance, reuse its port and paths:

```powershell
node scripts/run-ui-screenshots.mjs --attach --port=<PORT_FROM_PREVIOUS_RUN> --vault=.tmp/ui-visual-smoke/runs/<run-id>/vault --profile=.tmp/ui-visual-smoke/runs/<run-id>/profile --out=.tmp/ui-visual-smoke/runs/<run-id>/screenshots
```

To create another independent instance and avoid a port/profile collision:

```powershell
node scripts/run-ui-screenshots.mjs --launch --port=9250 --vault=.tmp/visual-smoke-new/vault --profile=.tmp/visual-smoke-new/profile --out=.tmp/visual-smoke-new/screenshots
```

**Safety:** The script requires all paths inside repository `.tmp` with no symlink/junction traversal, **refuses an already-existing vault/profile in launch mode**, and requires its own synthetic-vault marker in attach mode. It verifies the exact live `app.vault.adapter.getBasePath()` and rejects configured remotes before plugin interaction. It never clicks Sync now, unlocks Force Push/Pull, or performs GitHub mutations. With no credentials, both Force actions are **rejected before a destructive modal opens**. A missing screenshot/window fails the run rather than passing silently.

**Environment note:** Obsidian 1.14 opens Settings in a *different Electron window/CDP page* (title `Settings - <vault> - Obsidian`, URL `about:blank`). The script detects this popout by the synthetic vault title and captures that target, then returns to the main vault page for Sync Center. The first-run Restricted Mode opt-in may load the plugin asynchronously, so the runner waits until the plugin and its settings are actually registered.

## Verified evidence from a fresh synthetic vault

The original fresh Windows 11 / Obsidian 1.14.4 run on CDP port **9250** passed **29 protocol/DOM checks and captured 12 real PNG images** with zero observed JavaScript exceptions. After UI-125 and CLI isolation hardening, a second fresh end-to-end run via `pnpm test:ui:visual` passed **27 checks, 12 images, zero observed JavaScript exceptions**. The reduced check count reflects replacing locked Force-modal checks with explicit no-modal rejection checks, not lost coverage. All images below came from that actual run and contain synthetic-only data. A full `report.json` with exact dimensions, widths, page states and warnings is generated locally each run. These are curated snapshots committed to the audit branch:

| Screenshot | What it demonstrates |
| --- | --- |
| [Settings general](ui-real-screenshots-2026-10-16/01-settings-general.png) | Installed plugin settings and section headings in Obsidian's actual settings window |
| [Settings dirty state](ui-real-screenshots-2026-10-16/02-settings-dirty.png) | Save/Discard banner and warning that Sync/Force use the saved target |
| [375px Settings simulation](ui-real-screenshots-2026-10-16/06-settings-narrow-375.png) | **Known failing usability case:** Obsidian desktop's own sidebar consumes most of the narrow viewport |
| [Sync Center — commits](ui-real-screenshots-2026-10-16/07-sync-center-commits.png) | Normal right-hand dock, progress idle state and inline unconfigured-connection error |
| [Sync Center — current file](ui-real-screenshots-2026-10-16/08-sync-center-current-file.png) | Real Markdown note in main pane and Current file mode in the sidebar |
| [Force Push — unconfigured, after fix](ui-real-screenshots-2026-10-16/10-force-push-unconfigured.png) | Rejected action: explanatory Notice and **no** destructive unlock dialog |
| [Force Pull — unconfigured, after fix](ui-real-screenshots-2026-10-16/11-force-pull-unconfigured.png) | Same rejection; no remote operation |
| [Force Push — old behavior (before fix)](ui-real-screenshots-2026-10-16/10-force-push-confirmation.png) | Historical evidence of the former misleading `Repository: /` dialog, **not** the current UX |
| [Force Pull — old behavior (before fix)](ui-real-screenshots-2026-10-16/11-force-pull-confirmation.png) | Historical before-fix locked modal, retained for comparison |

Other locally generated images: initial vault, Settings bottom, theme-light/dark, Sync Center at simulated 375px. The images are reproducible using the command above rather than adding every screenshot to the repository.

## Confirmed UI findings through real screenshots

1. **UI-122 — MEDIUM, fixed:** Sync Center was embedded in a **300px-wide Obsidian sidebar** with only **276px** available for its grid, but the old desktop CSS demanded `220px + gap + 300px`. In a real screenshot, the detail pane's right edge extended beyond the sidebar (`1268px` vs `1012px`). A viewport media query did not help because the overall desktop window was wide. **Fix:** use `container-type: inline-size` on Sync Center and a 640px container query to stack master/detail by *available sidebar width*. On the same real dock, the detail pane now fits (`detailRight = layoutRight = 1012px`). The reusable visual test asserts this geometry on the real page. RED/GREEN stylesheet contract test added.
2. **UI-123 — LOW, fixed:** History-service errors already appeared inline in Sync Center, but also triggered a `Notice` overlay on top of the page title/action buttons. Changing modes caused multiple notices to stack. **Fix:** keep the persistent inline error without duplicating it as a toast. Verified visually and via updated RED/GREEN error-path regression.
3. **UI-124 — P1 usability finding, still open:** At a **375px CDP-emulated desktop viewport**, Obsidian's Settings popout retains its own left navigation. Only **175px** remain for plugin settings, with severe wrapping. This is **not a physical Android viewport test** and may require native app/Settings navigation behavior rather than only plugin CSS. Do not claim mobile support from the desktop-emulated screenshot.
4. **UI-125 — LOW UX issue, fixed for unconfigured repos:** Originally the Force confirmation for an empty synthetic vault displayed `Repository: /`. The plugin now validates nonempty **saved** GitHub owner, repo, and token before constructing any Force modal. The user sees `Configure and save your GitHub owner, repository, and token before using Force operations.` and no confirmation slider; 6 missing-field/operation combinations have RED/GREEN regression. The real Obsidian runner confirms both Force actions are rejected without any modal and records after-fix screenshots. **Separate P1 open:** configured-repo Force confirmation remains pointer-only and has not passed keyboard/screen-reader acceptance.

## Non-claims and next acceptance gates

- **No live GitHub E2E:** no credentials, repository setup, network mutation, remote history/preview data, or Force operation was exercised.
- **No physical Android/iOS screenshots:** CDP 375px emulation is desktop Electron only.
- **No end-to-end accessible keyboard completion of Force:** intentional safety gate remains for separate design and review.
- **No actual visual signoff of every theme, locale or plugin combination:** screenshots confirm real DOM/rendering for the listed synthetic states, not universal pixel-perfect behavior.
- Screenshots and runtime reports should contain **synthetic-only data**. Do not run the visual script on a personal vault. Script guards and CLI tests check out-of-project paths, low ports, occupied vault folders, and missing attach fixture markers, but screenshots still require human review before publication.
