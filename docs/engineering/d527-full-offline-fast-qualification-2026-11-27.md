# D527 — exact-source Full Offline Fast qualification (2026-11-27)

Source commit: `8f4ad06f166951560d987d157f18c1e3489f8c46` on the audit branch.

The D526 fix was followed by a complete, fresh offline qualification (task `4814a51e-a595-40f6-bdc1-fbebe1fac1b8`, exit 0, 2026-11-26 17:21:07–17:43:54 UTC). All 12 ordinary groups and 14 heavy groups completed: 1,838 passing cases across all 158 eligible Fast files, zero skipped. Independent `node scripts/run-fast-offline-qualified.mjs --finalize` (task `01858754-a6c1-451e-81b0-6ec8573b79c2`, exit 0, 2026-11-27) reproduced the same count and source fingerprint:

`76831b8fddde0d99485c7c31889351dd20b0cbd20d78c0bd5764749aef961f50`

Additional current-head checks after the evidence-only commit 5cbb49d: release metadata (65f6b114) and package artifact validation (ab6e7859) both exit 0 for v1.0.8. Post-documentation `--finalize` (2e73db9d) correctly rejected missing receipts for the changed fingerprint: docs are deliberately part of the fingerprint. The successful full run and independent finalize therefore qualify the pre-documentation snapshot only, not the new audit HEAD or a stable release. No fingerprint bypass or receipt copying. The Android read-only ADB probe (3e97e882) observed one connected device, no forwards (f12da9da), and `pidof md.obsidian` (b9a7eab1) exit 1 with no PID; no app launch, device write or native test was attempted. The exact disposable Vault must be verified before any live test.

The previous a43f5ef failure remains recorded in D526; no old-source receipts are credited. This is offline exact-source evidence, not native Obsidian, credentialed GitHub, physical Android or public Re-encryption Execute qualification. Existing native harness safety block remains in effect. Force/connection/scope and public Execute remain fenced. No production Vault, default branch, tag or release writes. Physical iOS testing was waived.
