# D154 — Preview Wizard in-flight Sync, close and Settings races

Date: 2026-10-29. Approved owner A: Node.js-first strict crash-safe Re-encryption, no Native Helper or GitHub Actions. Wizard stays **Preview-only** and public release gate **blocked**.

## Finding and change

Previously, the real UI `verifySource()` and `checkBranchAvailability()` checked `plugin.v4Runtime.isSyncing` **only before making asynchronous GitHub GETs**. If the user or timer started a local Sync while the request was pending, a positive Source or Branch readiness observation could still be stored after the request returned. This is unsafe *UI evidence*, even though the Wizard currently cannot publish or cut over.

`src/views/reencryption-wizard.ts` now checks `isSyncing` again at awaited API boundaries, and refuses a positive result while Sync is active:
- Source: after first repository identity GET, after default branch GET (also requiring the configured connection remains unchanged), after the expensive authenticated source verification, and after final repository/default-branch readback.
- Branch names: after destination/backup ref existence checks (also requiring unchanged settings), and after final repository/default/source-ref readback.
- When an active Sync is detected, the view reports a **fixed generic retry message**, never raw HTTP error/request context. Existing close/abort/request-epoch checks still prevent a destroyed modal from being updated.

This is a narrow *best-effort snapshot integrity* guard, **not** an OS-wide writer fence: a Sync that starts and finishes wholly between observations may not be detected, and other devices/apps can still mutate data after the last check. Real Cutover would still need independently proven global external writer exclusion, physically durable intent, and cross-store restart recovery. No permission or additional Native helper is granted.

## Test evidence

`tests/v4/reencryption-wizard-ui.test.ts` uses a real Wizard and GitHubClient via the Obsidian transport test hook. It suspends an actual requested repository GET using a Promise, then deliberately (a) marks Sync active, (b) changes connection token, or (c) closes the modal before releasing the response. Exercises both Source verification and Branch availability (six asynchronous interleavings), and asserts that neither Source verification nor branch readiness is newly marked successful; closed modal remains empty. It asserts every outgoing request is **GET without body**, no new authenticated source scan proceeds after early invalidation, and no token/old/new passphrase renders in the UI.

Existing D153 tests additionally prove an unchanged pinned source, moved HEAD/default/ref, missing source, and branch collision, with no network mutation.

No installed vault, GitHub E2E, SecretStorage, file sync, or release operations were performed. Release gate remains `blocked`.
