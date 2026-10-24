# D67 — Re-encryption Wizard: read-only, topology-independent readiness preflight

Date: 2026-10-24 (Asia/Bangkok).

## Purpose

The owner has made the Wizard a **hard blocker for the first public release**. The migration destination topology (A: isolated new destination, recommended; B: reuse old branch) is **not yet chosen**, so no remote mutation or key rotation is authorized. D67 adds only a read-only, pure-logic preflight in `src/lib/v4/reencryption-preflight.ts` with tests. It is not a functioning migration Wizard and does not advance any D66 release-gate status.

## Contract

`assessV4ReencryptionReadiness(input)` accepts:
- Authenticated V4 remote config bytes, the expected canonical source repository identity, a pinned full immutable 40-digit lower-hex Git commit SHA, and an independently observed source HEAD SHA.
- The proposed new PBKDF2 iteration count (600,000–1,200,000); the old count is extracted from the decoded remote config, **not** the current local user setting.
- Nine independently acquired safety evidence flags: authenticated source, complete snapshot, verified backup, idle sync, clear recovery/WAL, resolved conflicts, reconciled local changes, paused/coordinated other devices, and acknowledgement of the old Git-history/key-retention risk. A missing/false flag blocks the plan.

It reuses the production remote-config decoder to reject malformed KDF configuration, unbounded salt/cost and invalid repository identity before crypto. It refuses to infer completeness from a missing KDF or legacy encrypted layout; such sources show explicit blockers. It treats an unobserved or changed source HEAD as blocked. It emits only source repository ID, pinned commit SHA, existing/requested iteration counts, and a frozen list of blockers—never raw salt, token, passphrase, backup bytes, paths or encryption keys.

**Important security boundary:** The caller must obtain flags from trusted runtime operations and authenticated reads, not user-editable toggles. This is a pure decision/checklist engine, not a data-verification or cryptographic proof engine. It cannot certify a backup, an authenticated shard or a suspended second device by itself. Actual proof collectors and UI wiring depend on the owner-approved architecture.

The returned status is **always `blocked`**, with `destination-topology-unapproved` present even when all other input proofs pass. No API for initiating migration, writing files, creating Git refs, updating remote config, deleting data, or changing the current passphrase is exposed.

## Tests and implementation notes

- Regression tests use synthetic config and verify all nine independent missing-proof blockers, exact pinned-commit SHA semantics, source-HEAD races, untrusted KDF bounds/type failures, identity mismatch, legacy KDF/layout, and plaintext mode.
- No GitHub Actions, force-push/pull, release, remote configuration mutation, migration commit or personal-vault access.
- The D66 release gate at `docs/release-gates/reencryption-wizard.json` intentionally remains `blocked`. This readiness module is preliminary; it does **not** satisfy any of the seven release acceptance checks.
- Preserved constraints: maximum 100 MB physical fixtures and 8 MiB REST part policy.

## Owner decision still required

**A (recommended):** A genuinely new destination history, with a separately verified device-by-device cutover and unchanged old source retained for recovery. Decide **new branch in existing repo** vs **different private repository** as a confidentiality/access-boundary choice. Old ciphertext and Git history may still be present and should not be falsely claimed erased.

**B:** In-place rotation of the existing branch. Requires a separate design and formal acceptance of stale-client fencing, retained history and rollback semantics. Neither topology has been approved yet, so D67 deliberately stops before migration implementation.
