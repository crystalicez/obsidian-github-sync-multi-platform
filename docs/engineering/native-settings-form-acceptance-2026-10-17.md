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

The initial exact-commit clean worktree exposed a real harness prerequisite: the CLI fixture tests called `mkdtempSync` under the ignored `.tmp` folder even when no `.tmp` existed in a fresh checkout. `tests/v4/ui-visual-smoke-cli.test.mjs` now creates the project-local root and checks with `lstatSync` that it is a real directory rather than a symlink/junction. The four focused fixture tests passed after the fix. **Exact pushed source SHA `54f89061e8b087dab273d506f1664344a86213ca` was subsequently verified from a fresh, detached `.tmp/native-settings-final-clean-20261017` checkout.** Immediately after a frozen install and before any UI test, an independent check proved `freshTmpMissing=true`. Running `corepack pnpm test:ui:visual` there created its fixture directory and passed with **72/72 checks, 16 screenshots, zero observed UI JavaScript exceptions**, and only the already-known 175px narrow popout warning. From the same exact checkout, `test:fast`, `test:repeat` (10/10), `test:recovery`, `test:resource` (15/15), `test:feasibility`, `validate:metadata`, `validate:package`, and `test:github-e2e:compile` all exited 0. After the entire set, `git status --short --branch` remained exactly `## HEAD (no branch)` without source modification. This is clean audit-SHA evidence, **not** release approval for master.

## Real Settings token/passphrase Secret Storage acceptance

The same isolated Obsidian 1.14.4 UI runner now tests **both** sensitive Settings fields using deliberately invalid fixture strings only. It leaves GitHub owner/repository coordinates empty throughout and asserts no GitHub client is constructed. Neither credentials from `.env.github-e2e` nor any user's credentials are used.

After the plain Settings flow, it types a synthetic token into the real **GitHub token** password input, clicks the real **Encrypted sync** toggle, types a synthetic passphrase into the revealed **Encryption passphrase** password input, and clicks Save. It verifies that both fields are masked, the saved settings hold exactly the fixture inputs, the two generated Secret Storage IDs are distinct, `app.secretStorage.getSecret(id)` retrieves the expected corresponding fixture values, and `loadData().settings` contains **neither** plaintext secret property.

It then rotates **both** fixture values using those same text inputs and Save. The test proves that each secret ID has changed, each new Secret Storage slot is correct, the superseded slots have been scrubbed, and persisted `data.json` still contains neither secret. Finally it clears both fields through the form, turns encryption off through the UI, clicks Save and checks that **all** old and current secret slots are empty, the plugin has returned to plaintext/unconfigured mode, and no GitHub client exists. All checks return booleans or secret-ID labels, never the secret bytes or a real credential. No screenshots are captured while the fixture password fields contain values.

The first native UI run passed all new password/rotation/cleanup assertions but failed an older screenshot assertion because Settings stayed scrolled to the encryption controls. The runner now scrolls the existing dirty banner into view before that screenshot, preserving the full original assertion. **Full `corepack pnpm test:ui:visual` then passed with 79/79 UI checks, 16 screenshots, zero JS exceptions**, and the unchanged 175px desktop-emulation warning. The new credential test makes **no HTTP requests** and does not exercise real GitHub authorization.

## Qualification boundary

This improves **actual Settings entry, validation, persistence, secret creation, rotation, and clearing** evidence with synthetic credentials. It does **not** verify a valid token against GitHub, a real credentialed Settings-to-GitHub sync flow, OS-keystore security guarantees beyond the Obsidian Secret Storage API, mobile touch interaction, or physical screen reader usability.

The earlier credentialed GitHub E2E test at immutable source SHA `569e69dc1c50941bbde1f2dacae5d552faac8626` passed 4/4 tests on the isolated disposable test repository with independent branch cleanup confirmation. The previous intermittent encrypted recreate failure remains an open root-cause investigation. This Settings UI test makes no remote mutations and changes neither that evidence nor the release decision. PR #8 stays Draft.
