# D175 — Re-encryption Source Index root contract matches installed V4 Runtime

Date: 2026-10-30. Status: internal cross-stage storage-contract hardening; first-release Wizard remains **Preview-only** and the release gate **blocked**.

## Problem and safe decision

The V4 Runtime has always used the plugin-private adapter namespace root `github-sync-v4-index`. D134–D172 shadow, local intent, Selector, proposed receipt and restart inspectors each validated only multi-component roots such as `private/v4-index`. This made the internal migration path incapable of accepting the **existing** Source Index, tempting an unsafe relocation or a second Source copy.

D175 retains the original Source Index at its exact physical path beneath the plugin's private Obsidian adapter. No migration or moving/renaming/copying of existing Source data is introduced. The storage scope is **the relative plugin-private adapter namespace**, never a vault-root or arbitrary physical path. `src/lib/v4/reencryption-index-root.ts` exports `V4_RUNTIME_INDEX_ROOT` and `isSafeV4ReencryptionSourceIndexRoot()`: legacy safe multi-component roots continue working; the **only** permitted one-component root is the actual `github-sync-v4-index`. Empty segments, traversal, backslashes, absolute paths, reserved sibling data roots and arbitrary single-segment names remain invalid. Runtime now imports the shared constant, eliminating a second literal.

The common scope guard is applied consistently to:

- D134 independent Shadow Index staging;
- D135/D170 local prepared-uncommitted Cutover Intent;
- D136/D171 read-only restart evidence;
- D139/D171 read-only local crash-window classification;
- D142 hypothetical proposed commit identity/receipt inspection;
- D145/D172 isolated Source, Shadow and Selector root planning;
- D137 full encrypted remote Destination ↔ local Shadow binding.

With run `run_example123`, Source stays `github-sync-v4-index`; Shadow is `github-sync-v4-index-rekey-run_example123`; prepared Intent resides at `github-sync-v4-index-rekey-intent-run_example123/intent.json`; prepared Selector evidence at `github-sync-v4-index-rekey-selector-run_example123/prepared.json`. These are disjoint sibling namespaces in the **same** private plugin adapter. Nothing selects a Destination, moves an Index, rewrites Settings/SecretStorage, releases the D173 Sync Fence or authorizes a local Cutover.

## Verification and limitations

New D175 checks cover the exact runtime-root and malicious alternatives, independent Shadow staging with byte-for-byte Source preservation, local Intent one-shot readback and replay refusal, AES-GCM proposed receipt identity acceptance limited to the explicit runtime root, D136/D171 restart and D139/D171 crash-window read-only inspections under the runtime root, full independent D137 Git tree/commit encrypted Destination readback with the runtime Shadow path, and D172 encrypted Prepared Selector write/reopen under that same root with Settings still pinned to Source. Existing nested-root and tampering cases continue unchanged.

**Full Fast 1152/1152 PASS**, focused Shadow, Selector, Intent, Proposed Receipt, Restart, Crash Recovery, remote binding and Prepared Selector PASS. Recovery, Feasibility, Resource **11/11**, maximum strict TypeScript, Production Build, GitHub E2E compile-only **3 bundles**, metadata/package validators and exactly 100,000,000-byte SHA-256 soak all **PASS**. The new end-to-end storage mapping tests are in-memory adapter/isolated Git mock checks; D175 did not run live credentialed GitHub, installed Obsidian migration on desktop/mobile or physical power cut.

**Still blocked:** The active Index must never be overwritten before an independently authenticated local Cutover commit. No authoritative durable committed Selector/receipt, transactional Settings+SecretStorage+active Index switch, integrated Wizard Run, cross-process writer exclusion, or installed-platform recovery has been proven. The current D174 fence and quiescence code remains internal and pre-cutover-only. Do not enable the Wizard, release, merge, enable GitHub Actions, introduce Native Helper or delete old passphrase/branches without the necessary independent proofs and owner decisions. Keep `docs/release-gates/reencryption-wizard.json` `blocked`.
