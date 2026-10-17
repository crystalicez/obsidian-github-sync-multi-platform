# Selective file deletion — product decision and V4 safety gate

Status: **Decision partly resolved; destructive execution NOT implemented or enabled.** Draft PR #8; no release or merge.

## Confirmed product decision (17 October 2026)

The maintainer chose **“ให้เลือก” — choose the destination on every Delete / Remove operation**. The chooser must offer two explicit, initially unselected destinations:

1. **Delete from GitHub** — name the repository, branch, exact file path and inspected commit SHA.
2. **Delete from this Obsidian Vault** — name the active vault and exact file path.

A separate explicit confirmation is required after selecting a destination, including a warning about the next automatic/normal sync. A modal close or Cancel must do nothing. Never silently select a default, apply a global persistent default, or convert this into Force Push / Force Pull.

**Important:** this settles *where the immediate deletion would occur*, not the long-term cross-device propagation policy. These are distinct architectural choices.

## Evidence: current V4 normal sync propagates one-sided deletions

Current `planV4Sync` compares last-synced baseline, local state and remote state by stable file ID. Added executable regression tests in `tests/v4/planner.test.ts` confirming:

- If a tracked file exists remotely but is deleted locally, the next normal sync plans a **remote DELETE push**.
- If a tracked file exists locally but is deleted remotely, the next normal sync plans a **local DELETE pull**.
- With an unknown baseline and a local-only file, normal sync plans a **CREATE push** instead.

Therefore a naïve **Delete locally only** control will commonly delete the GitHub file on the next normal sync, and a naïve **Delete from GitHub only** control will commonly delete the Vault copy on the next sync (or re-upload it in other baseline/dirty cases). Wording such as “only this side” is **not truthful** without a new durable per-side exclusion/intent mechanism.

Never implement a selective GitHub deletion by direct GitHub Contents API requests: V4 encrypted/plaintext metadata, packed/chunked objects, journal, index and atomic branch-head semantics must remain consistent. Similarly, direct Vault trash without coordinating its normal-sync event path and recovery guards is not a safe one-sided operation.

## Open maintainer decision before any destructive action

**After deleting from the chosen side, should the file stay on the other side across future automatic/normal syncs?**

- **A — Keep only the chosen deletion right now; normal sync may later propagate the deletion or restore a copy.** Simpler to implement, but clearly warn and never promise permanent side isolation.
- **B — Keep the file on the other side until the user explicitly changes this decision.** Requires durable, per-file side-specific ignore/tombstone intent, protection against auto-sync/restarts, and a carefully defined re-enable action. More complex but aligns with many users’ expectations of “only on this side.”

No default has been selected, and no destructive UI or runtime operation is enabled. The maintainer must decide A or B. This question is intentionally kept distinct from whether to put content in Obsidian trash versus permanently remove it; the implementation should still prefer recoverable trash for Vault deletion once safety is decided.

## Implementation acceptance gates after decision

- Stale immutable Git ref/changed settings/stale local size+mtime must abort prior to deletion. Validate scope, exact file ID, repository, vault and path.
- Reject when a sync is active or queued if it cannot be safely serialized. Avoid submitting raw mutations outside the V4 session/recovery model.
- Explicit destination selection, keyboard/screen-reader support, no default, confirmation and cancel/close no-op.
- Distinguish removed object references in packs/chunks without deleting storage shared with other live files.
- Handle power loss/retry/post-publish uncertainty, and do not leave a partially published V4 head.
- RED→GREEN tests for both choices, edge cases, active sync and reopen/restart; native Obsidian UI smoke, separate clean checkout and credentialed disposable-GitHub E2E only.
- Do not involve users’ real vaults/repositories during tests, do not commit `.env.github-e2e`, and preserve unrelated WIP `tests/v4/github-transport.test.ts`.
