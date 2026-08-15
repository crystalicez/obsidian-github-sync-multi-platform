# Conflict Resolution and Git History UI Design

Date: 2026-08-16
Status: Approved design, pending implementation plan
Target branch: `agent/conflict-history-ui`
Reference UX: `silvanocerza/github-gitless-sync` (clean-room behavioral inspiration only)

## 1. Purpose

Add a first-class conflict resolution workspace and upgrade the existing GitHub Sync Center into a diff-oriented Git history workspace.

The feature must preserve the V4 sync safety properties already present in the repository: conflict detection, optimistic/CAS-style remote-head validation, recovery behavior, bounded resource use, encrypted storage handling, and the existing local-change pipeline.

The reference plugin is licensed AGPL-3.0 while this repository is Apache-2.0. No source code, CSS, component implementation, or other copyrightable implementation detail will be copied from the reference. The implementation will be clean-room and use this repository's existing Obsidian-native architecture.

## 2. Goals

### Conflict resolution

- Replace the current per-file conflict modal with a dedicated `ItemView` conflict workspace.
- When a sync run has multiple conflicts, collect them into one batch and pause the run until all are resolved.
- Support real three-way, hunk-level text conflict resolution using BASE / LOCAL / REMOTE.
- Provide hunk actions equivalent to:
  - Accept local
  - Accept remote
  - Accept both
  - Discard both / restore BASE for that hunk
- Let the user manually edit the final merged result before continuing sync.
- Support multiple conflict files in one workspace with tabs / file picker and unresolved counts.
- Default to split view on desktop and unified view on mobile, with a user-selectable mode that is remembered.
- Support binary conflicts at file level with preview where practical.
- Keep the current sync run suspended and resume that logical run after resolution, rather than starting a new manual sync.
- Revalidate both local and remote state before applying user resolutions so stale decisions are never silently published.

### Git history

- Upgrade the existing Sync Center rather than creating a second unrelated history view.
- Preserve `Repository history` and `Current file` concepts, but make the workspace master/detail and diff-oriented.
- Show text diffs and image/binary previews for historical versions.
- Track per-file history by V4 logical `fileId`, so history survives renames.
- Add `Restore this version` for a file.
- Restore by writing the historical content into the local vault and letting the normal V4 change/sync pipeline publish it later.

## 3. Non-goals for this iteration

- Whole-commit revert.
- Arbitrary compare between any two user-selected commits/versions.
- Branch browser.
- Git staging/index UI.
- Cherry-pick.
- Persisted plaintext or encrypted conflict drafts across application restart.
- Semantic Markdown merge at heading/block level.
- Binary content merging.
- Collaborative/live conflict editing.
- Copying implementation or styling from the reference AGPL plugin.

The architecture should not prevent future arbitrary version comparison or whole-commit revert, but neither is part of this delivery.

## 4. Existing integration points

The implementation should build on current V4 structures rather than adding parallel infrastructure.

- `src/views/sync-center.ts`
  - existing GitHub Sync Center `ItemView`
  - existing repository commit history and current-file history entry points
- `src/lib/v4/history-service.ts`
  - existing commit listing, commit change lookup, historical previews, and `getFileVersions(fileId)`
- `src/lib/github-api.ts`
  - existing bounded/scheduled GitHub API access, commit/tree/blob methods
- `src/lib/v4/conflicts.ts`
  - existing conflict policy/actions and automatic text merge constraints
- `src/lib/v4/sync-session.ts`
  - existing conflict decision callback and merge application path
- `src/lib/v4/runtime.ts`
  - current conflict `Modal` and runtime-to-session callback bridge
- `src/setting.tsx`
  - existing plugin settings, including conflict policy
- `src/styles.scss`
  - existing Sync Center styling and Obsidian theme-variable usage

The current `askConflict` callback only exposes path/mtime-level information. Full conflict editing therefore requires extending the conflict/session boundary to expose bounded BASE / LOCAL / REMOTE content or lazy content handles.

## 5. Architecture

Use the following separation of responsibility.

### `V4SyncSession`

Owns sync planning, execution, remote-head validation, application, publishing, retry, and recovery semantics.

It discovers conflicts and creates a conflict batch. It must not own UI state.

### `V4ConflictResolutionCoordinator`

Owns the lifecycle of a pending conflict batch while the plugin process is alive.

Responsibilities:

- hold the currently pending batch
- expose observable state to views/status UI
- suspend/resume the awaiting sync session through one controlled promise/result boundary
- retain in-memory decisions and manual merged drafts when the view is merely closed
- invalidate stale file resolutions after local/remote revalidation
- discard the batch on explicit cancel or plugin unload

### `V4ConflictResolutionView`

A dedicated Obsidian `ItemView` responsible only for user interaction and rendering.

It must be safe to close and reopen without cancelling the pending conflict batch.

### `V4ConflictMergeModel`

Pure TypeScript, DOM-independent three-way merge/diff state.

Responsibilities:

- produce line-oriented three-way hunks
- classify auto-resolvable vs user-conflict hunks
- create and update the merged document
- apply hunk actions deterministically
- track hunk resolution state
- preserve manual merged edits
- generate final merged bytes

### Shared read-only preview/diff layer

History and conflict UIs should share presentation components where sensible, such as:

- text two-way diff display
- image preview
- binary metadata preview
- file/version labels

History must not depend on the editable three-way merge state machine.

## 6. Sync state flow and conflict batching

A conflict-bearing run conceptually becomes:

`planning -> waiting-for-conflicts -> revalidate -> applying -> publishing`

### Batch creation

During planning, conflicts are accumulated into one `ConflictBatch` instead of opening one modal at a time.

The batch contains:

- a unique `runId`
- the remote head SHA used for planning
- all conflict files found for that plan
- per-file path and V4 identity metadata
- local/remote mtimes and sizes when available
- BASE / LOCAL / REMOTE content fingerprints
- bounded text snapshots or lazy content accessors
- preview metadata for binary files

A batch must be complete before the conflict workspace asks the user to resolve it. No mutation that depends on conflict choices should be remotely published while the batch is waiting.

### Suspend behavior

The sync session awaits one batch-resolution result.

Closing the conflict view does not resolve or reject that wait. The coordinator remains alive and the Sync Center/status surface may reopen the conflict workspace.

### Continue behavior

`Resolve all & continue` becomes enabled only when every file is resolved according to its conflict type.

On continue, the coordinator returns final per-file resolutions to the waiting session. The session does not start a new top-level manual sync.

### Revalidation

Before applying resolved content, revalidate:

- current remote branch head
- current local file fingerprint/state for every affected conflict file

If the remote head changed, re-plan inside the same logical run. A previously resolved file may be reused only if the re-planned BASE / LOCAL / REMOTE fingerprint tuple is unchanged.

If a local file changed while the user was resolving it, invalidate that file and require review again rather than overwriting the newer local content.

Unrelated remote commits should not automatically discard all user work; unchanged conflict fingerprints may retain their decisions/manual merged content.

## 7. Conflict fingerprints

Every conflict file must have a stable fingerprint derived from immutable conflict inputs, conceptually:

`fileId + hash(BASE) + hash(LOCAL) + hash(REMOTE)`

Path/mtime alone is insufficient.

The fingerprint is used to decide whether a resolution can survive a re-plan. A changed fingerprint means the old decision is stale and cannot be applied automatically.

Hunk identifiers should be deterministic within one file fingerprint, based on normalized source ranges/content rather than transient DOM/editor positions.

## 8. Three-way text merge model

Text conflicts use BASE / LOCAL / REMOTE.

The line-oriented merge model classifies changes at minimum as:

- `local-only`: local differs from BASE, remote equals BASE; auto-accept local
- `remote-only`: remote differs from BASE, local equals BASE; auto-accept remote
- `same-change`: local and remote produce the same change; auto-resolved once
- `conflict`: both sides modify overlapping BASE regions differently

Additional rules:

- different insertions at the same BASE position are a conflict
- delete-vs-edit is a conflict
- identical insertion/change is not duplicated
- adjacent but non-overlapping edits should remain separate when deterministic
- beginning/end-of-file and empty-file cases must be supported
- newline handling must preserve a deliberate final newline decision and avoid accidental whole-file churn

The algorithm will be implemented clean-room in pure TypeScript. No runtime diff dependency is required by the design.

## 9. Hunk action semantics

For a user-conflict hunk:

### Accept local

The merged output for the hunk becomes the LOCAL replacement.

### Accept remote

The merged output for the hunk becomes the REMOTE replacement.

### Accept both

The merged output becomes LOCAL followed by REMOTE, matching the visual order used in the unified conflict block.

This operation is literal and deterministic; it must not perform heuristic de-duplication.

### Discard both

The merged output becomes the original BASE content for that hunk.

For a conflict consisting only of competing insertions at an empty BASE position, `Discard both` therefore produces no inserted content.

The unified UI may label this action `Base` when space is constrained, while its accessible/full label remains clear.

## 10. Manual merged editing

The merged result is an editable document and is the final authority for the bytes that will be applied.

Hunk buttons are editing aids, not a regeneration recipe that rebuilds the entire file after every click.

Requirements:

- applying a hunk action patches only the range controlled by that hunk
- manual edits elsewhere survive subsequent hunk actions
- switching Split / Unified does not regenerate or lose the merged document
- undo/redo is available in the merged editor
- `Reset file` restores the current conflict file to its initial merge state, with confirmation when manual work exists
- real Git conflict marker text (`<<<<<<<`, etc.) is not inserted automatically; conflict boundaries are UI decorations only

### Manual-resolution state

The model tracks mapped merged-document ranges for unresolved conflict hunks.

A manual edit that intersects the output range of an unresolved conflict hunk marks that hunk `manually-resolved`. Manual edits outside unresolved conflict ranges do not resolve a hunk.

If a later hunk action is applied to a manually resolved hunk, that action replaces only that hunk's mapped result range and the UI must make the replacement evident so manual work is not silently discarded.

A text file is considered resolved when every user-conflict hunk is one of:

- accepted-local
- accepted-remote
- accepted-both
- discarded-both
- manually-resolved

Auto-resolved hunks do not require a user decision.

## 11. Conflict workspace UI

### Header and file navigation

The workspace contains all files in the current conflict batch.

Desktop should provide a horizontally scrollable file-tab bar plus an `All conflicts` selector for large batches.

Each file entry shows state:

- unresolved count
- resolved/check state
- stale/remote-changed warning
- binary/file-level indicator

A global summary shows total files and resolved conflict counts.

### Desktop default: Split

Desktop defaults to Split when the setting is `auto`.

Primary layout:

1. file tabs / batch status
2. LOCAL and REMOTE read-only diff panes
3. central or aligned hunk action controls
4. editable Merged Result pane
5. previous/next conflict controls and final batch action

LOCAL and REMOTE panes should use synchronized scrolling where practical. Line numbers and changed-range highlighting are expected.

The merged editor should receive enough space to remain the primary editable result rather than a tiny preview.

### Mobile default: Unified

Mobile defaults to Unified when the setting is `auto`.

Each conflict block shows context plus LOCAL and REMOTE alternatives in one vertical flow, followed by touch-sized actions.

Sticky navigation should expose previous/next conflict and progress.

The user may still select Split explicitly, but the UI may warn that Unified is more suitable for narrow widths rather than forcibly changing the setting.

### View mode setting

Add a persisted setting conceptually:

`conflictViewMode: "auto" | "split" | "unified"`

Default: `auto`

- desktop + auto -> split
- mobile + auto -> unified

Changing mode must preserve all batch decisions and manual merged text.

### Resolved-conflict visibility

Provide a `Show resolved conflicts` control.

When hidden, previous/next navigation skips resolved hunks by default.

## 12. Binary and non-text conflicts

If a conflict cannot safely participate in the text merge path, resolve it at file level.

This includes:

- unsupported extension/content type
- malformed/non-decodable text
- content over the configured text-merge size ceiling
- arbitrary binary formats

### Preview behavior

Attempt preview only where practical and bounded:

- images: LOCAL / REMOTE image previews plus dimensions/size when cheaply available
- PDFs: render only if the existing Obsidian/browser environment supports it safely without a new heavyweight subsystem; otherwise metadata-only
- unknown binary: filename, extension/MIME when known, sizes, timestamps, truncated hashes for diagnostics

Preview failure must never block file-level resolution.

### File-level actions

- `Use local`
- `Use remote`
- `Keep both`

`Keep both` must reuse the repository's existing safe conflict-copy semantics rather than invent a second naming policy. The original local content remains at the logical local path and the remote alternative is materialized through the existing conflict-copy behavior.

For delete-vs-file cases, labels should describe the actual operation (`Keep deletion`, `Restore remote`, etc.) instead of presenting misleading generic text.

Binary `Accept both` concatenation is not supported.

## 13. Conflict workspace lifecycle

### Close view

Closing only the `ItemView` does not cancel sync.

The coordinator keeps the conflict batch and in-memory drafts alive. Sync Center/status UI shows a `Waiting for conflict resolution` state and offers a route back to the workspace.

### Cancel sync

Provide an explicit `Cancel sync` action separate from the normal pane-close control.

Cancel discards the pending batch and causes the waiting sync run to exit without applying the unconfirmed merged results.

### Plugin/app unload

Pending conflict drafts are process-memory only.

On plugin unload/application shutdown:

- abort the active waiting sync through existing cancellation lifecycle
- do not publish partial conflict resolutions
- do not persist plaintext BASE / LOCAL / REMOTE / merged drafts to plugin data or the vault

On next startup, a fresh sync re-plans from real state.

This iteration deliberately does not add a cross-restart encrypted conflict-draft subsystem.

## 14. Conflict failure handling

- Network loss while editing does not invalidate the in-memory editor; connectivity is needed again only for continue/revalidation/publish.
- Remote-head change triggers re-plan and selective invalidation/reuse by fingerprint.
- Local change while waiting invalidates the affected file before application.
- GitHub API error after resolution remains governed by normal V4 retry/recovery behavior.
- Decryption failure places the affected file in an error state and prevents final continuation until the content can be obtained safely.
- Malformed or oversized text downgrades to file-level resolution.
- No merged result is treated as a force-push instruction.

## 15. Sync Center / History workspace

The existing Sync Center remains the single history workspace.

Primary modes:

- `Repository history`
- `Current file`

Desktop uses a master/detail layout. Mobile may collapse the same information into stacked navigation without changing the underlying history model.

## 16. Repository history

The master list shows commit metadata:

- commit message
- author
- authored time
- plugin-synced vs external classification when available
- changed-file count after details are loaded

Selecting a commit opens its changed-file list. Selecting a changed file opens a before/after preview.

Text changes use a read-only two-way diff. Image/binary changes use the same preview infrastructure used by conflict UI where possible.

Change kinds should be explicit: create / modify / delete / rename.

Rename display should show old path -> new path.

History content is loaded lazily; the commit list does not fetch every blob up front.

## 17. Current-file history

Current-file history follows the logical V4 `fileId`, not merely the current path.

The version timeline therefore survives renames.

Selecting a historical version shows:

- historical path
- action/change kind
- commit and timestamp
- previous-version versus selected-version preview/diff
- `Restore this version`

For a delete event, the last existing content may still be previewed from its preceding version.

Arbitrary user-selected A-vs-B version comparison is deferred.

## 18. History preview service changes

The existing history service currently has a generic preview path. The history UI needs explicit before/after access for selected changes.

Extend the history service with bounded methods that return historical sides explicitly, conceptually:

- before preview
- after preview
- content kind and byte-size metadata

The service remains responsible for:

- plugin history journal interpretation
- external-commit tree comparison
- encrypted historical storage decoding
- size ceilings
- binary/image/text classification

The UI must not issue raw GitHub requests around the service.

## 19. Restore-version semantics

Restore is a local file operation followed by normal V4 synchronization.

It must not create or amend a Git commit directly from History.

Flow:

1. user previews a historical version
2. user chooses `Restore this version`
3. UI shows confirmation with current path, selected version/commit/time, and overwrite implications
4. historical bytes are fetched/decrypted through the existing V4 history/storage path
5. validate that the current local state still matches the fingerprint observed when the preview was opened
6. write historical bytes to the local vault
7. normal V4 local-change detection/enqueue path handles the edit
8. later normal sync publishes it with regular conflict/CAS/recovery protection

### Current renamed file

Restoring an old version of a file that has since been renamed restores the historical content into the file's current logical path by default. It does not rename the file back to the historical path.

### Currently deleted file

When the logical file no longer exists locally, the action becomes `Restore file`.

Use the latest safe historical path represented by that logical file history to recreate the local file, subject to the same path-safety checks used elsewhere in V4.

If the desired restore path is occupied by an unrelated current file, do not overwrite it silently; require a safe alternative or abort with a clear conflict.

## 20. Restore precondition and failure behavior

When a historical preview opens, record a current-local fingerprint/precondition.

At restore time:

- if local still matches, proceed
- if local changed, block the default restore and offer `Refresh comparison` or explicit `Restore anyway`

`Restore anyway` is an explicit local overwrite only. Remote publication still follows normal V4 conflict/CAS logic.

Failure rules:

- historical fetch/decryption failure -> no local change
- path validation failure -> no local change
- local write failure -> report failure and do not enqueue/claim successful restore
- write succeeds but later sync fails -> restored local content remains as a real local edit and is eligible for a later sync retry

The restore flow does not create a second automatic backup file in this iteration.

## 21. Resource and privacy constraints

The repository currently has no runtime dependencies. Preserve that lightweight posture unless implementation evidence proves a small dependency is necessary.

Requirements:

- pure TypeScript merge/diff core where possible
- do not load all historical blobs eagerly
- lazily load active conflict/history previews
- maintain existing text-preview/text-merge byte ceilings unless a measured change is approved separately
- bound in-memory caches and release inactive previews
- revoke generated object URLs when views/previews are replaced or closed
- do not write decrypted historical/conflict content to disk as cache
- route encrypted historical content through the existing codec/key infrastructure

If CodeMirror 6 modules are needed for the merged editor, use only the minimum official modules compatible with Obsidian and verify build/bundle/resource impact before accepting them. Merge semantics remain independent of CodeMirror.

## 22. Accessibility and theming

- use Obsidian theme variables instead of hard-coded light/dark palettes
- do not communicate conflict state by color alone
- provide accessible labels for icon-only/hunk actions
- maintain keyboard navigation for desktop
- provide touch-sized controls for mobile
- expose resolved/unresolved progress in text
- ensure focus can move between file selection, conflict navigation, actions, and merged editor

The visual result should feel native to Obsidian while preserving the interaction ideas shown in the reference screenshots.

## 23. Testing strategy

The feature must integrate with the repository's existing test runner rather than creating a separate framework.

### Merge-model unit coverage

- local-only change
- remote-only change
- identical change
- overlapping edits
- insertion/insertion at same position
- delete/edit
- adjacent hunks
- start/end-of-file edits
- empty files
- CRLF/LF handling
- final newline behavior
- Unicode/emoji
- Accept local
- Accept remote
- Accept both ordering
- Discard both -> BASE
- manual-edit preservation
- mapped range behavior after edits

### Conflict batch/session coverage

- multiple conflict files in one run
- run waits for complete batch resolution
- close/reopen view does not cancel batch
- explicit cancel does not publish
- local mutation while waiting
- remote-head mutation while waiting
- unchanged fingerprints reuse prior decisions
- changed fingerprints selectively invalidate
- no partial publish before resolution phase completes

### Binary coverage

- previewable image
- preview failure does not block resolution
- unknown binary
- oversized text downgrade
- use local / use remote / keep both
- delete-vs-file labels/semantics

### History coverage

- repository commit -> changed file -> before/after preview
- current-file versions by `fileId`
- rename history
- create/delete preview
- encrypted historical content
- external Git commit
- lazy loading / preview limits

### Restore coverage

- restore an old version into current logical path
- restore after historical rename
- recreate currently deleted file
- occupied restore path protection
- unchanged local precondition
- changed local blocks default restore
- explicit restore-anyway
- failed fetch does not mutate local
- failed write does not enqueue sync
- successful write becomes a normal local dirty change

### Resource/recovery coverage

- bounded memory for many conflict files
- preview cache eviction
- repeated open/close views
- object URL cleanup
- network failure before and after conflict resolution
- CAS/retry/recovery path after resolution

### UI/lifecycle coverage

Where practical with the repository's test environment:

- desktop auto -> split
- mobile auto -> unified
- switching view mode preserves merged text and decisions
- unresolved/resolved counters
- navigation skips resolved hunks when configured
- close/reopen preserves in-memory batch state
- accessibility labels and mobile-width layout smoke checks

## 24. Verification gates before implementation is considered complete

Run and pass at least:

- `pnpm build`
- `pnpm test:fast`
- `pnpm test:repeat`
- `pnpm test:recovery`
- `pnpm test:resource`
- `pnpm test:feasibility`
- `pnpm validate:package`

Add targeted feature tests to the existing runner so the standard CI path exercises the new merge/history behavior.

## 25. Acceptance criteria

The feature is complete when all of the following are true:

1. A sync run with multiple text conflicts opens one conflict workspace and remains suspended until all required conflicts are resolved or explicitly cancelled.
2. Text conflicts support deterministic hunk-level local/remote/both/base decisions and an editable final merged result.
3. Desktop defaults to split and mobile defaults to unified under `auto`, and switching modes preserves state.
4. Binary/unsupported conflicts remain resolvable at file level even if preview fails.
5. Closing the view does not accidentally cancel the run; explicit cancel does.
6. Local or remote changes during resolution cannot cause stale conflict decisions to be blindly applied.
7. Sync Center presents repository and current-file history with lazy before/after diff/preview.
8. Per-file history follows V4 logical identity through rename.
9. Historical file content can be restored locally, with local-change precondition checking, and is then published only through normal V4 sync.
10. No implementation or CSS is copied from the AGPL reference project.
11. Existing safety/resource/recovery test suites remain green and new targeted tests cover the feature semantics above.
