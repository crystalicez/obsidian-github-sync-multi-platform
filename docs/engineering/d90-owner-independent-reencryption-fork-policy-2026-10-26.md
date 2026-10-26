# D90 — FINAL owner decision: Re-encryption is an independent branch fork (2026-10-26)

> **D91 UX follow-up (owner approved):** Re-encryption MUST produce/retain the **three branch roles** source + pinned frozen backup + newly encrypted orphan destination in the same physical GitHub repository. The owner explicitly accepted the 5-step separate Wizard and its safety/metrics/finish flow. See [D91 approved Wizard UX](d91-owner-approved-reencryption-wizard-ux-2026-10-26.md). This supplements, and does not weaken, D90 independence of old-branch clients.

**Authority:** The owner explicitly approved this model after discussing and rejecting the previous multi-device migration/freeze/check approach. This **supersedes the old-device pause/ack requirement in D87 and the proposed migration-specific Pre-Sync blocking from the interrupted D90 experiment**. It does NOT reverse the approved same-repo backup location B, Node.js-only restriction, old-branch retention, migration safety/recovery release gate, or the policy of no GitHub Actions.

## Product behavior

Re-encryption is **COPY / FORK**, not a coordinated move of all devices. The initiating device chooses the existing source branch and creates a **new, isolated zero-parent (orphan) destination Git branch**, containing the *logical data encrypted again* with the newly selected passphrase and KDF settings. Do **not** implement this as an ordinary Git branch clone that retains old ciphertext or Git history; the new branch must have a fresh config/repoId appropriate to the new branch, new cryptographic material, re-encrypted objects, a complete index, and independently verified content.

The migration captures an **exact, authenticated, immutable Git source commit** as the fork's snapshot boundary. At that moment, subsequent writes to the source branch are **allowed and intentionally independent**; they are *not* mirrored/merged to the destination. During the fork's own snapshot acquisition, verify the selection and all data are consistent against that exact commit. If a live reference changes before the snapshot boundary is securely chosen, the implementation must make the snapshot boundary explicit and cannot silently combine two different source revisions. An intentional later source HEAD advance alone is **not** a reason to fence the old branch or retroactively fail a fork of an authenticated immutable commit.

The initiating device may automatically switch its own Sync configuration to the destination branch/new encryption settings **only after** the new orphan branch, verified backup, complete integrity, recovery proof and local cutover prerequisites have passed. This is a one-device post-success switch; no automatic deletion or modification of old branch.

Every other device is autonomous: it may **remain on the old branch and continue normal Sync forever** using the old passphrase, or **manually** switch to the new branch and enter the new passphrase. No all-device registration, online acknowledgement, forced pause, remote client freeze, synchronized cutover, background reconciliation, auto-redirect, or auto-merge is required. Warn that the branches diverge and changes on one are not reflected on the other; switching an already diverged device to the new branch may create local-vs-remote conflicts that must use ordinary fail-safe Sync/conflict rules. Never silently overwrite local notes to make a device "follow".

## Pre-Sync behavior

Keep existing per-branch correctness checks for **every** Sync (startup, manual, scheduled and local-change): expected exact Git ref/branch and repository, V4 remote config and encryption compatibility, recovery/conflicts, change guard, publication CAS and retries. The D90 experiment to invent a cross-branch *migration marker* and block Sync on the old source branch **is rejected**. Do not require an external migration-status lookup merely to permit ordinary Sync on an old branch. Future clients may improve per-branch safety preflights, but **must not block an otherwise valid old-branch Sync solely because a new re-encrypted branch exists**. Older clients receive no special version-synchronization requirement.

## Backup/security/release limitations unchanged

Owner approved B: the **verified backup branch in the same physical GitHub repository** is sufficient backup topology for first release, with explicitly accepted shared-repository failure risk. Preserve source and backup until an explicit user deletion request. A safe unique create-only backup ref, authenticated full readback and independent restore rehearsal still need evidence. Do not treat a matching Git ref pointer alone as verified backup.

The initiating device's local edits during its own preparation/cutover must be handled safely (pause or detect/revalidate); this is **not** a global pause of other devices. Node.js-only Windows WAL directory fsync returned EPERM (D86) and durability is not qualified; do not silently relax the crash-recovery standard. First-release Re-encryption Wizard remains **blocked** pending actual migration, durability, recovery, correct orphan-branch publication, second-device restore, and platform acceptance. No real GitHub/vault writes or re-encryption were performed to record this decision.

## Implemented policy snapshot and deferred work

- `src/lib/v4/reencryption-owner-decisions.ts` states independent fork topology, old-branch independent Sync, initiating-device post-verification switch, other devices optional manual switch, no fleet online barrier and no migration-specific Pre-Sync blocking.
- `src/lib/v4/reencryption-preflight.ts` no longer treats other-device coordination or a migration marker as a release prerequisite; it **still always returns blocked** because production Wizard is incomplete, plus all other applicable checks.
- `GitHubClient.getGitRef()` refuses a 200-OK response containing an unexpected branch or non-commit type as a separate per-branch safety hardening. This is compatible with independent branch forks.
- Superseded uncommitted `reencryption-presync-policy.ts` and its test were withdrawn without being committed; no migration guard was connected to production Sync.
- Implementing an actual secure fork is **separate future engineering** and must not be mistaken for completion of this policy decision.
