# Conflict Resolution and Git History UI Design

Date: 2026-08-16
Status: Design v2 — self-reviewed against current V4 codebase; implementation plan blocked pending user approval
Target branch: `agent/conflict-history-ui`
Reference UX: `silvanocerza/github-gitless-sync` (clean-room behavioral inspiration only)

## 1. Purpose

Add a first-class conflict-resolution workspace and upgrade the existing GitHub Sync Center into a diff-oriented Git history workspace.

The feature must preserve the V4 safety properties already present in this repository: logical file identity, conflict detection, bounded I/O, source-stability checks, Git ref/CAS publication, crash recovery, encrypted storage handling, change guards, and normal local-change synchronization.

The reference plugin is AGPL-3.0 while this repository is Apache-2.0. No source, CSS, component implementation, or other copyrightable implementation detail will be copied. This is a clean-room implementation using this repository's Obsidian-native TypeScript architecture.

## 2. Approved product scope

### Conflict resolution

- Dedicated Obsidian `ItemView`, not a sequence of modals.
- One workspace for every unresolved conflict in one logical sync run.
- Text conflicts support real three-way BASE / LOCAL / REMOTE resolution at hunk level.
- Hunk actions: Accept local, Accept remote, Accept both, Discard both / BASE.
- The final merged text is editable by hand before continuation.
- Desktop defaults to Split; mobile defaults to Unified; the user can switch and remember the mode.
- Binary/unsupported content uses file-level resolution and best-effort preview.
- Closing the pane does not cancel the run; explicit Cancel does.
- Resolve all conflicts first, then resume the same logical run.

### Git history

- Upgrade the existing Sync Center rather than create another unrelated history view.
- Modes: Repository history and Current file.
- Master/detail commit/version navigation with before/after diff or preview.
- Current-file history follows the V4 logical `fileId` while that identity exists.
- Add file-version Restore.
- Restore is a local vault mutation; remote publication happens only through normal V4 sync.
- Whole-commit revert is not part of this iteration.

## 3. Explicit non-goals

- Whole-commit revert.
- Arbitrary A-vs-B commit/version comparison.
- Branch browser, staging/index UI, cherry-pick.
- Cross-restart persisted conflict drafts.
- Semantic Markdown AST/block merge.
- Binary merging.
- Collaborative/live merge editing.
- Copying implementation or styling from the AGPL reference.

## 4. Current codebase constraints and integration points

The implementation must extend existing V4 paths rather than bypass them.

- `src/views/sync-center.ts`: existing Obsidian DOM `ItemView`, async render-generation guards, progress card, repository history, current-file versions, text/image/binary preview.
- `src/lib/v4/history-service.ts`: commit paging, journal/external change discovery, preview, and `getFileVersions(fileId)`.
- `src/lib/github-api.ts`: scheduled/bounded GitHub reads/writes, commit/tree/blob APIs.
- `src/lib/v4/conflicts.ts`: current policies/actions and 2 MiB text-merge ceiling.
- `src/lib/v4/planner.ts`: conflict detection by `fileId`, including path/presence as well as content changes.
- `src/lib/v4/sync-session.ts`: planning, resolved batch construction, staging, publication, recovery, CAS handling.
- `src/lib/v4/runtime.ts`: outer CAS retry loop, current conflict modal, progress integration.
- `src/lib/v4/sync-coordinator.ts`: one active run plus queued local changes.
- `src/lib/v4/staging-store.ts` / recovery: existing transient plaintext staging after a mutation is confirmed.
- `src/setting.tsx`: current conflict policy setting.
- `src/styles.scss`: existing native Obsidian styling.

The project currently has no runtime dependencies. The first implementation should keep that property unless measurements demonstrate a compelling need.

## 5. Architecture

### `V4SyncSession`

Owns planning, conflict discovery, lazy materialization of conflict inputs, application, publication, retry/recovery semantics, and pre-publication validation. It must not own DOM state.

### `V4ConflictResolutionCoordinator`

Runtime-scoped controller for one pending conflict batch.

Responsibilities:

- bind a pending batch to `runId` and batch generation
- expose immutable/renderable state to the view/status surfaces
- hold user decisions and merged drafts in memory
- resolve or reject the session's one batch-await boundary
- preserve compatible decisions across a re-plan by fingerprint
- invalidate stale generation loaders and stale file resolutions
- settle promptly when the run's AbortSignal is aborted
- discard state on explicit cancel or plugin unload

Only one logical conflict workspace may exist for a pending batch. Reopen/reveal the existing leaf rather than create independent resolver instances.

### `V4ConflictResolutionView`

Dedicated Obsidian `ItemView`. Rendering only; no Git mutation logic.

It uses its own render generation in addition to coordinator/batch generation so stale async preview/materialization callbacks cannot mutate a newer view.

### `V4ConflictMergeModel`

Pure TypeScript, DOM-independent model for bounded three-way text diff/merge, hunk state, mapped output ranges, manual edits, and final bytes.

### Shared read-only diff/preview layer

Conflict and History may share two-way text diff presentation, image preview, binary metadata preview, and version labels. History never depends on the editable three-way merge state machine.

## 6. Conflict policy behavior

Preserve the existing default `copy` policy and make UI behavior explicit:

- `copy`: keep current automatic keep-local/copy-remote behavior; do not open the workspace.
- `newer`: keep current automatic mtime-based behavior; equal mtimes fall back to keep-local/copy-remote; do not open the workspace.
- `ask`: every planner conflict is presented in the workspace. Non-conflicting regions inside a text file may still be auto-merged in the model, but the conflict batch requires user confirmation.
- `merge`: attempt the new bounded three-way merge first. If all content and structural dimensions are safely resolvable, continue automatically. If any unresolved content/path/presence conflict remains, open the workspace instead of silently falling back to copy.

The `merge` policy therefore intentionally improves on the current overlap fallback. Update the setting description to make this clear, e.g. `Merge text; ask when unresolved`.

Force Push and Force Pull do not invoke the conflict workspace because the planner already gives those operations authoritative one-way semantics.

## 7. Conflict is structural as well as textual

A V4 conflict is not merely LOCAL text versus REMOTE text. `planV4Sync` compares logical identity, path, presence, and content.

Every conflict side is modeled as:

```text
SideState = ABSENT | { normalizedPath, plaintextHash, size, mtime, contentHandle? }
```

The resolver separately reasons about:

1. presence/existence
2. path/rename
3. content

### Structural rules

- BASE/LOCAL/REMOTE all exist at one effective logical target path and text is safe: hunk editor is available.
- One side renamed while the other remains at BASE path: the changed path is structurally non-conflicting; content can still use three-way merge.
- Both sides rename the same `fileId` to the same path: path is resolved; content is handled normally.
- Both sides rename to different paths: explicit structural path conflict. The user must choose LOCAL path, REMOTE path, or whole-file Keep both where valid.
- Edit vs delete: file-level structural conflict. Deletion is absence, never an empty text document.
- Rename vs delete: file-level structural conflict.
- Competing creates with no BASE: no `Discard both = empty file` interpretation. BASE absence means file absence. Use file-level resolution unless a future create/create merge policy is explicitly designed.
- Hunk-level `Accept both` is only available after the structural model has one logical target file. It is not a substitute for choosing two paths.

### File-level action semantics

- `Use local`: LOCAL side is authoritative, including its path/presence/content.
- `Use remote`: REMOTE side is authoritative.
- `Keep both`: only valid when both sides contain materializable files. Preserve LOCAL as the primary logical file and materialize REMOTE through the repository's existing conflict-copy naming/identity mechanism.
- If one side is absent, use concrete labels such as `Keep deletion` / `Restore remote`; do not expose a meaningless Keep both.

Any chosen target path must pass existing path-safety and case-insensitive collision rules before continuation.

## 8. Conflict fingerprints and batch generation

Content hashes alone are insufficient because unchanged bytes can still participate in divergent rename or delete conflicts.

A reusable file-resolution fingerprint is conceptually:

```text
repo/run context
+ fileId
+ BASE  { exists, normalizedPath-or-ABSENT, plaintextHash-or-ABSENT }
+ LOCAL { exists, normalizedPath-or-ABSENT, plaintextHash-or-ABSENT }
+ REMOTE{ exists, normalizedPath-or-ABSENT, plaintextHash-or-ABSENT }
```

Paths are normalized using the V4 vault-path rules and NFC for fingerprint stability; case-insensitive collision validation remains a separate safety check.

A changed path, presence bit, or content hash invalidates the previous resolution. Mtime is useful for diagnostics/preconditions but is not the identity of a resolution.

Hunk IDs are deterministic only inside one file fingerprint and derive from normalized source ranges/content rather than DOM positions.

The batch also captures repository/run context (repo identity, branch/config generation, and `runId`). A retry under a changed repository/config context must never reuse old decisions.

## 9. Lazy conflict materialization and resource bounds

Do not eagerly load BASE + LOCAL + REMOTE for every conflict file.

Batch discovery first produces metadata/fingerprints. The session exposes a generation-scoped lazy materializer for a selected file. Materialization:

- loads only the sides required by the active file/policy
- uses existing V4 codec/decryption and resource controls
- enforces text merge limits before whole-buffer reads where possible
- may cache the active/adjacent file within a bounded budget
- releases inactive preview buffers/object URLs
- becomes invalid when batch generation changes

For `merge`, auto-resolution may materialize conflicts sequentially so one large batch never requires all three versions of every file in memory simultaneously.

## 10. Bounded text-diff model

The existing 2 MiB byte ceiling remains an upper bound, but bytes alone are not a sufficient CPU bound. A 2 MiB file can contain hundreds of thousands of tiny lines.

The clean-room diff implementation must therefore be deterministic and bounded by both content size and an explicit work/line budget. A bounded Myers/patience-style implementation or equivalent is acceptable; the implementation plan must pick constants and test them.

If the work budget is exceeded, the UI must degrade safely to file-level resolution rather than freeze the Obsidian UI.

Text qualification requires:

- supported text extension/type
- all required sides within the text ceiling
- fatal UTF-8 decoding succeeds
- binary-looking content (notably NUL-heavy/control-heavy data) is rejected

Line tokenization must preserve:

- LF / CRLF / lone-CR behavior
- mixed EOL sequences without accidental whole-file normalization
- UTF-8 BOM where present
- intentional final-newline presence/absence
- huge single-line files

Repeated-line ambiguity must still produce deterministic hunks.

## 11. Three-way merge classifications

For content where BASE/LOCAL/REMOTE all exist:

- `local-only`: LOCAL differs from BASE; REMOTE equals BASE → auto LOCAL.
- `remote-only`: REMOTE differs from BASE; LOCAL equals BASE → auto REMOTE.
- `same-change`: both produce the same replacement → auto resolved once.
- `conflict`: overlapping incompatible replacements, competing insertions at the same BASE location, delete-vs-edit, or other non-equivalent overlap.

Adjacent but genuinely non-overlapping changes stay separate when the bounded algorithm can prove it deterministically.

The initial merged document uses all safely auto-resolved changes. For unresolved content hunks it uses BASE as the neutral placeholder, not an implicit LOCAL or REMOTE bias.

## 12. Hunk action semantics

For an unresolved text hunk:

- Accept local → output exactly the LOCAL replacement.
- Accept remote → output exactly the REMOTE replacement.
- Accept both → LOCAL replacement followed by REMOTE replacement in the displayed order, with exact token/EOL preservation and no heuristic de-duplication.
- Discard both / Base → restore exactly the BASE region.

For an insertion conflict whose BASE region is empty, Discard both produces no insertion.

No Git marker text (`<<<<<<<`, etc.) is inserted into the real merged document automatically; conflict boundaries are UI decorations.

## 13. Manual merged editing

The merged result is the final authority for the bytes to apply.

Hunk buttons patch only the mapped output range for their hunk. They never regenerate the whole file and thereby erase unrelated manual edits.

Manual edit rules:

- an edit intersecting one unresolved hunk marks that hunk `manually-resolved`
- an edit spanning multiple unresolved hunk ranges marks every intersected hunk manually resolved
- an edit outside unresolved hunk ranges does not resolve anything
- editing an already resolved or auto-resolved region changes final text but does not create a new unresolved hunk
- a later hunk action on a manually resolved hunk replaces only that mapped range and must be visually explicit
- every edit/action updates downstream mapped offsets deterministically
- paste, undo, redo, and IME/composition input must go through the same model update path

A native Obsidian DOM editor/`textarea` abstraction is preferred for the first implementation to preserve the no-runtime-dependency posture. Previous/current value common-prefix/suffix detection may be used to map generic DOM edits into model ranges. CodeMirror is not required by the design.

`Reset file` returns the current file to its initial auto-merge state (unresolved conflict ranges showing BASE) and requires confirmation if manual work exists.

Switching Split / Unified is presentation-only and never reconstructs the merge model.

## 14. Resolution completeness

A text file is resolved only when:

- all required structural decisions are resolved, and
- each user content conflict is one of accepted-local / accepted-remote / accepted-both / discarded-both / manually-resolved.

A binary/unsupported file is resolved when its file-level structural action is chosen.

`Resolve all & continue` is disabled until every current-generation file is complete and error-free.

## 15. Sync flow and conflict batching

Conceptual flow:

```text
planning
→ conflict metadata batch
→ policy auto-resolution / waiting in resolver
→ continue requested
→ local + remote revalidation
→ re-plan if stale
→ prepare resolved batch
→ final pre-publish conflict guard
→ publish under existing Git ref CAS
→ existing recovery/local commit path
```

The current per-conflict `askConflict(path, mtime...)` callback should become one batch-resolution boundary. The session does not open UI one file at a time.

No conflict-dependent remote mutation is published while the resolver is waiting.

## 16. Revalidation and pre-publication guard

This is a hard correctness invariant: user decisions based on stale conflict inputs must not be published.

### On `Resolve all & continue`

Re-read/verify:

- current remote branch HEAD against the plan's expected head
- each affected conflict file's current LOCAL presence/path/content fingerprint

If remote HEAD changed, re-plan in the same logical runtime run. Reuse only resolutions whose full structural/content fingerprint remains identical.

If LOCAL changed, invalidate that file and require review again.

### Immediately before Git ref publication

The existing recovery flow can discover local-target changes after a remote candidate was already published, so user-resolved conflict files need an additional pre-publish guard.

Before `publishV4CandidateRef`:

- verify conflict-local targets still satisfy their resolved-input snapshot
- use stat as a fast path, but hash when stat changed or when a full fingerprint check is required
- large files must use existing bounded hashing/content-source machinery
- if a conflict input changed, abort candidate publication and re-plan instead of relying only on post-publication local recovery preconditions

The existing Git ref CAS remains the authoritative remote race guard.

This extra guard is specific to user-resolved/staged conflict decisions; ordinary non-conflict push behavior remains under the current source-stability/CAS mechanisms.

## 17. CAS retry and coordinator interaction

`V4PluginRuntime.execute` already retries stale-ref/recovery-replan conditions within one top-level coordinator run. Conflict UI must fit that model.

- One `runState.runId` owns the conflict coordinator state across retry attempts.
- Every re-plan advances batch generation.
- Identical fingerprints can reuse decisions/drafts.
- Removed conflicts disappear from the workspace.
- Newly discovered conflicts are added.
- If the re-plan has no unresolved conflicts, the pending workspace is completed/closed automatically.
- Old lazy materializers and async view callbacks fail closed when generation mismatches.

Local vault events occurring while the run is active remain queued by `V4SyncCoordinator`; conflict-local prepublication validation prevents those queued edits from being overwritten/published through a stale resolution.

## 18. Cancel, close, unload, and settings changes

### Close pane

Closing the ItemView does not resolve or cancel the pending batch. The coordinator remains alive in memory. Reopening reveals the same batch.

If Obsidian restores the view when no batch exists, render a harmless `No active conflicts` state.

### Explicit Cancel sync

Cancel is separate from pane close. It settles the resolver wait and terminates the active run without publishing unconfirmed conflict results.

Add a truthful terminal progress lifecycle/status for user cancellation (preferred: `cancelled`) rather than leaving progress stuck in `active` or reporting a false success/no-change.

### Plugin/app unload

Coordinator disposal aborts the waiting resolver promptly. No partial conflict publication occurs. Drafts are not restored on the next app start; a fresh sync re-plans.

### Relevant settings/repository change while waiting

A pending batch is bound to its repository/config/run context. If owner/repo/branch/storage mode/scope/credential generation changes while a conflict run is waiting or between CAS attempts, invalidate/cancel the pending batch and require a fresh sync rather than applying it to a newly configured target.

Changing only conflict view presentation mode is safe and does not invalidate the batch.

## 19. Progress and status integration

Keep conflict waiting as lifecycle `active` with phase `resolving-conflicts`; do not reuse the existing `waiting` lifecycle, which currently represents debouncing behavior.

The Sync Center/status surface should show a human label such as `Waiting for conflict resolution` and unresolved counts when available.

Current status-bar click behavior must change:

- pending conflict batch → reveal/open Conflict Resolution view
- no pending conflict and runtime idle → normal manual sync action
- active non-conflict sync → no second sync

## 20. Conflict workspace UI

### Shared header

- file tabs with unresolved/error/stale/binary badges
- horizontally scrollable tabs plus `All conflicts` selector for large batches
- global file/conflict progress
- Split / Unified selector (`auto | split | unified` persisted in settings)
- Previous / Next unresolved conflict
- Show resolved conflicts
- Resolve all & continue
- explicit Cancel sync in a non-accidental location

### Desktop auto mode

Split view:

```text
LOCAL read-only diff | aligned hunk actions | REMOTE read-only diff
---------------------------------------------------------------
Editable Merged Result
```

Synchronize local/remote scrolling where practical; show line numbers and changed-range highlighting.

### Mobile auto mode

Unified vertical blocks with BASE context, LOCAL/REMOTE alternatives, touch-sized actions, sticky conflict navigation, and editable merged result.

The user may force Split on narrow screens; warn if useful but do not silently change their setting.

### Async rendering safety

All preview/materialization results must check both view render generation and conflict batch generation before updating DOM.

## 21. Binary and unsupported conflict preview

Preview is best-effort and never a prerequisite for resolution.

- images: local/remote preview plus dimensions/size where cheap
- PDF: render only if safely supported by existing platform capabilities; otherwise metadata
- unknown binary: path/type, size, mtime, truncated plaintext hash metadata
- preview failure: show error/metadata and keep file-level actions enabled

Before/after image views can require multiple simultaneous object URLs. Manage them as a bounded collection and revoke all on replacement/close, rather than the Sync Center's current single-URL assumption.

## 22. Keep-both collision behavior

Reuse current `runState.conflictCopies` / conflict-copy naming semantics so a CAS retry preserves the reserved identity/path when still valid.

Before application, recheck that the reserved conflict-copy path remains unoccupied and does not introduce a case-insensitive collision. If the path became occupied while the user was waiting, invalidate/re-reserve safely; never overwrite the new occupant.

## 23. History workspace

Keep the existing Sync Center and preserve its native DOM/master-detail pattern and async render-generation guards.

Primary modes:

- Repository history
- Current file

History reads are independent from sync mutations and should fail locally in the view without changing sync state.

## 24. Repository history semantics

Commit list shows message, author, time, source (`Synced` vs `External`), and changed-file count when loaded.

Selecting a file shows before/after:

- text: two-way read-only diff
- image: before/after preview
- binary: metadata/preview where supported
- create: empty/absent before side
- delete: absent after side
- pure rename with identical content: rename metadata plus `content unchanged`

Merge commits use first-parent comparison to match the current history service behavior.

### External commits

Current external history is path/tree based and does not carry V4 logical `fileId` semantics.

- plaintext repositories: show ordinary Git path changes. Exact rename inference is allowed only when old/new blob identity pairing is unambiguous; otherwise display delete + create rather than guess.
- encrypted V4 repositories: an external commit that bypasses V4 journals is not safely interpretable as logical plaintext V4 history. Show a warning/raw Git metadata where available and disable logical diff/Restore when safe decoding cannot be proven.

## 25. Current-file history and pagination

Current-file history follows plugin journal `fileId` across renames.

Do not silently stop after the current `getFileVersions(fileId, maxPages=20)` default. Replace the fixed hidden cap with incremental pagination/load-older semantics and an explicit `hasMore`/truncated state.

External path-only commits are not silently attached to a logical `fileId` timeline unless identity can be proven.

Selecting a version compares it to its immediately preceding version in this iteration. Arbitrary A-vs-B comparison remains out of scope.

## 26. History preview service changes

Extend `V4HistoryService` with explicit bounded before/after APIs instead of reusing `after ?? before` preview.

The service remains responsible for journal parsing, encrypted historical decoding, external tree comparison, preview classification, and safety limits.

Add bounded service-level caching for immutable commit metadata/tree maps so selecting multiple files from one commit does not recursively refetch the same tree for every side. Cache keys are commit/tree SHAs and are evicted with the history service/view generation.

A truncated Git tree remains a fail-safe error; do not guess missing historical blobs.

History service instances must be invalidated when repository/config/credential generation changes so a long-open Sync Center does not keep operating on a stale target configuration.

## 27. Restore semantics

Restore is a local user edit, not a Git mutation.

Flow:

1. select a historical version by immutable commit SHA/descriptor
2. capture the current local restore precondition/fingerprint
3. user presses Restore and confirms target/version
4. revalidate the local precondition
5. materialize historical content through the V4 history/codec path
6. validate path/collision rules
7. write/commit into the local vault
8. reflect the result as a normal local change according to current sync settings

The Restore button is disabled while a sync run is active, including while conflict resolution is pending. This prevents History from mutating a file inside the active run's snapshot.

Double-click/repeated Restore is serialized and the action is disabled while the first restore is in flight.

## 28. Restore and local sync settings

Restore must respect user sync settings.

- Always complete the confirmed local restore if the local/path preconditions remain valid.
- If sync-on-local-change is enabled and watch is active, route the restored path into the normal local-change queue exactly once.
- If automatic sync is disabled, do not force a sync. Show `Restored locally; sync manually when ready`.
- Avoid duplicate vault event + explicit enqueue by performing restore through a runtime helper that suppresses its own vault event and then explicitly enqueues only when policy allows.
- A restore path outside current sync scope may be restored locally after a clear warning, but it is not queued/published until scope allows it.

## 29. Restore path and logical identity

### Existing logical file, including historical rename

Restore old content into the file's current logical path by default. Do not rename it back to the historical path.

### Currently deleted logical file

Repository history may restore historical content whose `fileId` is no longer present in the current local/remote index.

For this iteration, recreate it as a **new local logical file identity** at the latest safe historical path. This avoids an unreliable cross-restart one-shot resurrection seed and avoids silently reusing an identity that is absent from current state.

The UI should make this clear (`Restore file as new local file`). Preserving/resurrecting the old `fileId` across deletion can be a separate future feature if durable identity-seeding semantics are designed.

Before creating:

- normalize with `normalizeV4VaultPath`
- reject unsafe `.` / `..` / empty paths
- reject file-vs-folder collisions
- reject case-insensitive collisions with unrelated logical files
- if occupied, do not overwrite silently; require another path or abort

## 30. Large-file Restore is not limited by preview

`V4_HISTORY_PREVIEW_MAX_BYTES` is a preview limit, not a restore limit.

Do not make a valid historical file un-restorable merely because it exceeds 5 MiB.

- small historical content may be read/decrypted whole
- large/chunked historical content should use existing `V4StorageCodec.readToSink` + `V4StagingStore` and then existing bounded stage commit where possible
- packed encrypted records follow current codec/resource limits; if safe bounded restoration cannot be provided, fail clearly rather than exceed memory limits

Restore can remain available even when visual preview is unavailable because of size/type, provided the historical descriptor can be materialized safely.

## 31. Restore stale-local precondition

When preview/version selection opens, capture the current target state. At Restore time:

- unchanged → proceed
- changed → block default action and offer Refresh comparison or explicit Restore anyway

Use content hash where practical; size/mtime alone is not a sufficient identity guarantee. Large-file verification uses bounded hashing.

`Restore anyway` is an explicit local overwrite only. Remote sync still follows normal conflict/CAS behavior.

Historical fetch/decryption/path/write failure must leave local content unchanged whenever the failure occurs before commit. If local commit succeeds but later sync fails, the restored local edit remains for a later retry.

## 32. Privacy, draft persistence, and existing staging

Conflict BASE/LOCAL/REMOTE snapshots and manual drafts are process-memory only while the user edits. Do not create a new plaintext conflict-draft/cache file.

This does **not** mean the final confirmed merged result can bypass existing V4 staging/recovery. After `Resolve all & continue`, confirmed final bytes may enter the repository's existing transient staging/recovery mechanism, which can place plaintext stage data under the plugin staging area as current V4 local-recovery behavior already does.

The design promise is therefore:

- no new persisted plaintext draft/cache while waiting for user decisions
- confirmed mutations continue to use existing V4 recovery/staging guarantees
- encrypted Git remote content remains encrypted through the normal codec path

## 33. Failure behavior

- network loss while editing: keep in-memory model; revalidate on Continue
- remote branch deleted/rewritten: fail/re-plan safely; never force old decisions
- local file renamed/deleted/edited while waiting: invalidate that file by structural fingerprint
- config/credential target changed: cancel/invalidate batch
- decrypt/auth failure: mark file error; no Continue
- text diff budget exceeded: downgrade safely to file-level resolution
- preview failure: never blocks file-level resolution
- stale history commit no longer fetchable: show refresh/error; no restore
- Git tree truncated: fail safe
- plugin unload: abort pending resolver promptly and clean in-memory drafts

## 34. Test strategy

Use the existing Node test runner and extend existing Obsidian stubs where needed. Do not introduce a parallel test framework.

### Pure merge/diff tests

- local-only / remote-only / identical change
- overlap / competing insertion / delete-vs-edit
- adjacent hunks / repeated-line ambiguity
- file start/end / empty file / huge single line
- CRLF, LF, lone CR, mixed EOL
- BOM and final-newline preservation
- Unicode/emoji
- malformed UTF-8 / NUL-heavy pseudo-text downgrade
- very high line count/work-budget downgrade
- Accept local/remote/both/base exact output
- manual edit one hunk / multiple hunks / outside hunk
- undo/redo/paste/IME-equivalent edit mapping
- mapped offset updates after actions/edits
- Split/Unified switch does not alter model

### Structural conflict tests

- rename vs unchanged path + edit
- same rename both sides
- divergent rename
- delete vs edit
- delete vs rename
- competing create with no BASE
- path/presence change invalidates fingerprint even when content hash is identical
- case-insensitive collision after path choice
- conflict-copy path becomes occupied while waiting

### Policy tests

- copy unchanged behavior
- newer unchanged behavior including equal-mtime copy fallback
- ask always yields workspace batch for planner conflicts
- merge auto-resolves clean three-way conflict
- merge opens workspace for unresolved overlap/structural conflict instead of old copy fallback
- forcePush/forcePull never open conflict resolver

### Batch/session tests

- multiple conflicts → one batch wait
- close/reopen view does not settle wait
- explicit cancel terminal state and no publication
- abort/unload settles wait promptly
- local edit while waiting invalidates before publish
- local edit after Continue but before ref update trips final conflict guard
- remote HEAD change re-plans
- unchanged fingerprints reuse decisions
- changed path/presence/hash selectively invalidates
- retry generation invalidates stale loader callbacks
- repository/settings generation change invalidates run
- no partial conflict publication

### Resource/recovery tests

- many conflict files materialize lazily
- text work budget prevents pathological CPU/memory growth
- bounded large-file hashing
- preview cache eviction/object URL cleanup
- final confirmed merge still uses existing staging/recovery path
- network/CAS/recovery failures around resolved conflicts

### History tests

- plugin commit before/after text diff
- create/delete/rename display
- first-parent merge-commit behavior
- current-file timeline follows plugin `fileId` across rename
- load-older pagination beyond 1000 commits without silent truncation
- external plaintext commit path diff
- unambiguous vs ambiguous rename inference
- encrypted external commit disables unsafe logical diff/restore
- tree/commit cache avoids duplicate immutable tree loads
- truncated tree fails safe
- simultaneous before/after image URL cleanup

### Restore tests

- restore old content to current logical path
- historical rename does not rename current file backwards
- deleted historical file restores as new logical identity
- unsafe/occupied/case-colliding path blocked
- active sync disables restore
- unchanged/changed local precondition
- Restore anyway
- auto-sync enabled queues exactly once
- auto-sync disabled restores locally without forced sync
- outside-scope restore warns and does not queue
- >5 MiB historical file can restore without preview via bounded stage path
- failed materialization/commit does not report success

### UI/lifecycle tests

- desktop auto → split
- mobile auto → unified
- one existing conflict view is revealed, not duplicated
- stale async render generations do not mutate new view
- resolved/unresolved counters and navigation
- no-active-batch placeholder
- status-bar click opens pending resolver
- `cancelled` status rendering
- light/dark variables and touch-sized mobile controls smoke tests

## 35. Verification gates

Before implementation is considered complete, run at least:

- `pnpm build`
- `pnpm test:fast`
- `pnpm test:repeat`
- `pnpm test:recovery`
- `pnpm test:resource`
- `pnpm test:feasibility`
- `pnpm validate:package`

Add targeted feature tests to the existing runner so standard CI covers the new semantics.

## 36. Acceptance criteria

1. Multi-file planner conflicts are represented in one generation-aware conflict workspace and suspend one logical run.
2. `copy` and `newer` keep current automatic behavior; `ask` opens the workspace; `merge` auto-merges safe cases and asks for unresolved cases.
3. Structural path/presence conflicts are resolved explicitly and deletion is never misinterpreted as empty content.
4. Text merge is deterministic, resource-bounded, EOL/BOM preserving, and supports hunk actions plus manual editing.
5. Closing the pane does not cancel; explicit Cancel terminates cleanly with truthful status.
6. Local, remote, path, presence, or configuration changes cannot cause a stale user resolution to be published.
7. A final conflict-local guard runs before Git ref publication in addition to existing CAS/recovery checks.
8. Binary/unsupported conflicts remain resolvable when preview/diff is unavailable.
9. Sync Center provides repository/current-file lazy before/after history without silent fixed-page truncation.
10. External/encrypted history is displayed only to the degree that identity/plaintext interpretation is safe.
11. Restore is local-first, disabled during active sync, respects auto-sync/scope settings, and does not force remote publication.
12. Preview size limits do not unnecessarily prevent bounded large-file restore.
13. Restore of a currently deleted historical file recreates a new logical local identity in this iteration.
14. No new plaintext conflict draft/cache is persisted; confirmed results may use existing V4 staging/recovery.
15. No reference-plugin AGPL source or CSS is copied.
16. Existing build/recovery/resource suites and new targeted tests pass.