# Force confirmation keyboard acceptance, 2026-10-17

## Behavior

The configured Force Push and Force Pull confirmation dialogs now expose the existing horizontal unlock control as a focusable ARIA slider. Left and Down decrement by 10 percentage points. Right and Up increment by 10 points. Home resets to zero. End sets the slider to 100. The slider reports its value and the chosen repository and branch to assistive technology. A visible focus outline identifies the keyboard target.

Unlock does not execute a Force operation. The user must select the separately revealed Force button. Cancel remains available. The runtime rechecks the settings generation before an unlocked Force button can trigger a destructive action. The pointer drag path retains the same two-step confirmation.

The keyboard path does not create a bypass for the saved-target requirement or modification guard. It does not solve every screen-reader interaction pattern, and no physical screen-reader evaluation is claimed.

## Verification

The code and tests were checked in the connected Windows development workspace using Node 24.11.0 and pnpm 9.12.3:

- Focused Force regression began RED in six cases, then passed 6/6 after the change. It covers keyboard unlock, pointer rollback and completion, cancel, duplicate clicks, and settings-generation invalidation for both Force modes.
- Production `pnpm build` passed and regenerated the distributed `styles.css`.
- `pnpm test:fast`, `pnpm test:repeat` (10/10), `pnpm test:recovery` (50/50), `pnpm test:resource` (15/15), `pnpm test:feasibility`, `pnpm validate:metadata`, `pnpm validate:package`, and `pnpm test:github-e2e:compile` passed.
- `pnpm test:ui:visual` passed on real Obsidian Desktop 1.14.4 in an isolated synthetic vault and Electron profile. The run reported 57/57 checks, 14 valid PNG screenshots and no observed JavaScript exceptions.
- The UI runner focused each real modal slider and used Electron CDP `Input.dispatchKeyEvent` with `ArrowRight`. After nine presses, the ARIA value was 90 and Force remained hidden. After ten, the value was 100 and Force was visible. The runner clicked Cancel and verified that no GitHub client existed. No Force action or remote mutation was invoked.

The UI screenshots are retained at [Force Push keyboard unlock](ui-real-screenshots-2026-10-17/15-force-push-keyboard-unlocked.png) and [Force Pull keyboard unlock](ui-real-screenshots-2026-10-17/16-force-pull-keyboard-unlocked.png). The screenshots came from the real native app. Automated DOM and PNG validation passed; this report does not claim a separate human visual review.

The runner creates only project-local disposable vault data. It installs an invalid synthetic token **in process memory only** to render the configured dialog. It neither persists that token nor constructs a GitHub client. Run the non-destructive acceptance again with:

```powershell
corepack pnpm build
corepack pnpm test:ui:visual
```

## Open release gates

- A human screen-reader and physical keyboard acceptance pass is still necessary before claiming complete accessibility.
- Physical Android and iOS interaction is not covered by the Windows Electron test.
- The existing 375px desktop Settings viewport warning remains. Obsidian's Settings popout leaves only 175px for plugin content; this is not a mobile-device test.
- Hosted CI, independent PR review, complete release qualification, and the other gates in `production-release-readiness-2026-10-10.md` remain open.
- The unrelated pre-existing uncommitted helper in `tests/v4/github-transport.test.ts` was intentionally excluded from this change.
