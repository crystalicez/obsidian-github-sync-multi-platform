# Real Obsidian Settings form acceptance — 2026-10-17

## What was exercised

Obsidian Desktop 1.14.4 on Windows, running the built plugin in a disposable **synthetic** vault and isolated Electron profile, opened its real separate Settings popout. The automated UI runner used actual text inputs and dispatched real DOM `input`/`change` events rather than calling the Settings draft methods to fabricate a pass.

It exercised the following sequence:

1. Enter invalid branch `bad branch` in the rendered **GitHub branch** input and click the real **Save changes** button. Confirm that the saved branch stays `main`, the draft remains dirty and Obsidian shows an invalid-branch notice.
2. Enter synthetic owner `synthetic-owner`, repository `synthetic-repo` and branch `testing/settings-ui` through the rendered text inputs, then confirm the plugin draft matches exactly.
3. Click the rendered **Save changes** button. Confirm the plugin's saved in-memory settings match all three strings, `loadData()` returns the same persisted strings, no credential or GitHub client is present and the dirty banner disappears.
4. Enter empty owner/repo and branch `main` through the real inputs and save again. Confirm in-memory and durable data both return to an unconfigured synthetic vault, with no GitHub client.
5. Continue the original UI inspection: unsaved draft banner, light/dark themes, emulated 375px desktop Settings popout, Sync Center, unconfigured Force rejection and keyboard unlock/cancel for both Force modes. Neither a remote sync nor any Force operation is invoked.

The CDP Settings popout is its own Electron JavaScript realm. The runner selects inputs by their exact visible setting labels, reads the native input setter from the input's own `ownerDocument.defaultView`, and raises input/change events from that window. This avoids an invalid cross-realm `instanceof HTMLInputElement` assumption.

## Real execution evidence

- Initial UI regression failures identified the test harness's cross-realm DOM assumption. After fixing the harness, the native runner **passed all 72 checks**, generated **16 valid PNG screenshots**, and observed **0 JS exceptions**.
- Two new PNGs captured the user-facing form before and after saving: [actual inputs with unsaved changes](ui-real-screenshots-2026-10-17/17-settings-real-form-edited.png) and [saved form](ui-real-screenshots-2026-10-17/18-settings-real-form-saved.png). These are synthetic owner/repo strings, not real credentials.
- Repeat using `corepack pnpm test:ui:visual` from a clean source checkout. Its test driver is `scripts/run-ui-screenshots.mjs`.
- The existing warning at an emulated desktop width of 375px remains: Obsidian Settings leaves only 175px of plugin content. This is not an Android/iOS compatibility result.

## Qualification boundary

This improves **actual Settings entry, validation, persistence, and rollback** evidence. It does **not** verify user-token entry, encrypted passphrase secure storage using the Settings form, actual remote authentication, a real credentialed Settings-to-GitHub sync flow, mobile touch interaction, or physical screen reader usability.

The earlier credentialed GitHub E2E test at immutable source SHA `569e69dc1c50941bbde1f2dacae5d552faac8626` passed 4/4 tests on the isolated disposable test repository with independent branch cleanup confirmation. The previous intermittent encrypted recreate failure remains an open root-cause investigation. This Settings UI test makes no remote mutations and changes neither that evidence nor the release decision. PR #8 stays Draft.
