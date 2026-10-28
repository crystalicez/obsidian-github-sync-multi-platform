# D147 — Real desktop Selector persistence boundary (Option A)

Date: 2026-10-28. The owner approved keeping the original Source Index immutable, with a separate destination Shadow Index and an independent authoritative selector design. This stage does **not** authorize cutover or modify installed plugin behavior.

## Isolated real-filesystem experiment

`tests/recovery/reencryption-selector-desktop-durability-probe.test.ts` uses **existing** `acquireV4DesktopRekeyWalStorage()`, not a new filesystem writer, to place an authenticated D146 AES-GCM Selector **test vector** into a two-slot WAL-format staging directory inside a freshly created disposable `.tmp/d147-selector-durability-*` directory. The actual D145 selector filename `selector.json` is **not** yet implemented by this WAL storage and must not be mistaken for an integrated persistence design.

The test checks that the encrypted test vector is really present on disk, does not contain plaintext identity or SecretStorage IDs, rejects a second OS writer during the exclusive lock, and remains byte-for-byte readable after releasing the lock and acquiring a new instance. It invokes the **actual** Node filesystem WAL crash-durability barrier both after the staged rename and after the fresh reopen. It does not mock successful `fsync`. All created files are confined to a unique disposable directory and are removed afterward. No installed Obsidian Vault, WAL, active Index, Shadow Index, Settings, SecretStorage or GitHub ref is read or modified.

### Observed result

On the Windows host, the focused real-disk test passed, with both direct durability checks **refusing confirmation**:

- After file fsync + rename: `win32 Node directory-sync claim after rename: refused; cutover blocked`
- After closing and reopening a fresh lock/adapter: `win32 Node directory-sync claim after reopen: refused; cutover blocked`

Ordinary filesystem persistence and a fresh handle readback passed. That is **not** evidence of survival through loss of power. The existing WAL's strict directory sync check correctly refuses to elevate readback into a proven crash-durable transaction. The test records actual results instead of hardcoding Windows as forever unsupported; if a future Node version returns success, it still needs independent OS power-loss and cross-store transaction qualification.

## Decision boundary

This settles one capability question: the existing Node-only WAL storage **cannot currently certify** an authoritative Selector on this Windows environment. It does not establish that no Node-only algorithm can ever work, and does not justify bypassing the proof. Do not silently accept file-level `sync` only, downgrade to best-effort, or add Native Helper binaries without owner approval. Research a standards-backed Windows persistence mechanism that preserves the strict crash-safe bar, or present the owner with an explicit architecture choice if Node-only approaches fail. Native Helper remains an isolated PoC only under prior approval; no release rollout is authorized.

The first release still needs physical power-loss qualification on desktop and mobile, a verified selector/Settings/SecretStorage/WAL transition, cross-process editor/vault writer exclusion, numeric physical GitHub repository attestation and live three-ref validation, installed Obsidian two-device recovery testing and independent security review. The migration Wizard remains **Preview-only**, and `docs/release-gates/reencryption-wizard.json` remains `blocked`.

### D147 verification record

Focused physical selector probe **1/1 PASS**, Recovery **90/90 PASS** (includes the probe), Fast **1054/1054 PASS**, Feasibility **136/136 PASS**, Resource **11/11 PASS**, max-strict TypeScript, production build, compile-only E2E three bundles, release metadata/package validators and **100,000,000-byte** SHA-matched crypto soak all passed on this Windows host. No actual GitHub mutation, installed-Obsidian acceptance, new platform-specific production mechanism, or physical power interruption was performed.
