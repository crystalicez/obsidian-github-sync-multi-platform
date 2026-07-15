# Detailed Sync Progress Design

## Goal

Replace the coarse sync status with accurate, structured progress emitted by the sync engine. Users must be able to see the current phase, the current logical vault path, and independent pull and push progress without a rapidly flickering interface.

The status bar remains compact. Its tooltip and the Sync Center provide the detailed view. Progress is runtime-only and must never persist logical paths to plugin settings, the local index, logs, or GitHub.

## Progress Model

The runtime owns one `V4SyncProgressSnapshot` and exposes read and subscribe operations to UI consumers. The snapshot contains:

- lifecycle status: idle, waiting, active, success, no-change, or failed;
- the active phase;
- the current logical vault path when the phase operates on a specific file;
- an optional current direction, pull or push;
- independent pull and push counters, each with completed and optional total values;
- the operation and trigger for the active run;
- the last completion timestamp;
- failure context containing the phase, path, counters, and error message at the point of failure.

The active phases are:

1. debouncing;
2. checking remote;
3. loading index;
4. scanning local;
5. planning;
6. blocked by the modification guard;
7. resolving conflicts;
8. downloading;
9. applying local changes;
10. hashing;
11. encrypting;
12. uploading;
13. committing;
14. saving the local index;
15. retrying.

Terminal states are no change, success, and failed. Idle is used before the first run and after no retained result is available.

Totals are optional until the engine knows them. Unknown totals render as an indeterminate phase rather than `0/0`. Counters are clamped so completed is never negative and never exceeds a known total.

## Counter Semantics

Pull and push counters remain separate because one normal sync can pull remote changes and then push independent local changes in the same run.

- Pull total is finalized after planning and conflict resolution determine the effective pull set.
- Pull completed increments only after the corresponding local write, delete, or rename has been applied successfully.
- Push total is finalized after planning and conflict resolution determine the effective push set.
- Push completed advances while each logical file is prepared and uploaded. A full push is not presented as a successful sync until the Git commit is created and the branch compare-and-swap update succeeds.
- Force Push normally has only push work; Force Pull normally has only pull work.
- A no-change run ends with pull and push totals of zero.
- If conflict resolution changes the effective plan, the totals are updated before transfer begins.
- A retry starts a new attempt and resets attempt-local completed counters so progress from a stale plan is not mixed with the replacement plan.

The primary counters use logical files. Large-file parts and metadata shards may be shown as phase-local secondary detail in the future, but they do not replace or inflate the logical pull and push totals in this version.

## Engine Integration

Progress originates at the code performing the work. `V4SyncSession` accepts an optional progress reporter and emits structured events at phase boundaries and inside file-processing loops. The reporter is observational: it cannot change ordering, planning, conflict decisions, or error behavior.

The runtime translates events into immutable snapshots and publishes them to subscribers. It also emits runtime-owned phases that sit outside the session, including debouncing, loading the local index, saving the local index, retries, and terminal results.

The coordinator reports waiting/debouncing state and preserves the existing single-active-sync rule. Repeated manual or force actions still report that a sync is already in progress and do not replace the active snapshot.

Every attempt follows this conceptual sequence:

`checking remote -> loading index -> scanning local -> planning -> pull phases -> push preparation phases -> uploading -> committing -> saving index -> terminal state`

Phases with no applicable work may be skipped. Conflict resolution and modification-guard blocking are inserted where required. External GitHub reconciliation uses the same pull/apply progress model.

## Rendering and Throttling

Phase changes are published immediately. Current-path and counter changes are deduplicated and rendered at most once every 400 milliseconds. The final pending update is flushed before a phase change or terminal state so the UI never misses completion of a phase.

Throttling happens in the runtime progress publisher, not in sync correctness code. This gives the status bar and Sync Center one consistent snapshot and prevents each view from implementing different timing behavior.

The first path in a new phase may render immediately. Subsequent paths and counters within that phase are batched. A path is cleared immediately when entering a phase that has no file context.

Closing the Sync Center unsubscribes its listener and cancels view-owned rendering callbacks. The runtime clears its throttle timer on plugin unload.

## Status Bar

The status bar shows a compact phase label and directional totals when known:

- `GH Sync: Checking remote...`
- `GH Sync: Applying · ↓3/10 ↑0/7`
- `GH Sync: Uploading · ↓10/10 ↑2/7`
- `GH Sync: Retrying...`
- `GH Sync: No changes`
- `GH Sync: Success`
- `GH Sync: Failed`

The tooltip contains the full phase label, current path, completed and remaining pull work, completed and remaining push work, and failure details when applicable. A missing total is described as unknown rather than displayed as zero.

## Sync Center

Every Sync Center mode includes one live status card above the existing commit/file layout. The card renders only from the current snapshot and does not reload history when progress changes.

The card shows:

- active phase or terminal result;
- current logical path, middle-truncated visually with the complete value in its tooltip;
- pull completed, total, and remaining values when known;
- push completed, total, and remaining values when known;
- final completion time;
- failure phase, path, and error message.

The view renders only its status-card subtree on progress updates. Commit pagination, selected commit, file history, and previews retain their state.

## Failure and Retry Behavior

If an operation fails, the runtime captures the most recently published phase, current path, and counters before transitioning to failed. The status bar remains compact; the tooltip and Sync Center show where the failure occurred.

Branch-head races enter retrying immediately, clear attempt-local completed counts, and then begin a new checking-remote phase. A modification-guard prompt enters blocked state and retains the planned counters. A conflict prompt enters resolving-conflicts and carries the conflicted path.

Progress callback failures are isolated from sync behavior. A subscriber or rendering exception must not abort, retry, or mutate a sync.

## Compatibility and Privacy

The existing `syncProgress` object is replaced or adapted behind one typed progress API. Callers must not infer phases from zero counters. Existing commands, notices, debounce behavior, and sync result semantics remain unchanged.

Logical paths appear only in the local Obsidian UI and in runtime memory. They are not persisted. Encrypted repositories continue to hide logical directories, filenames, extensions, and contents from GitHub.

## Verification

Tests must prove:

- status formatting for known and unknown totals;
- separate pull and push completed/total/remaining values;
- a normal pull-push run emits the expected phase order and both counter streams;
- Force Push and Force Pull expose only their applicable transfer direction;
- no-change runs do not masquerade as checking remote;
- conflicts expose the conflict path and revised totals;
- retries reset attempt-local progress;
- failures retain the last phase and path;
- path/counter updates are deduplicated, throttled to 400 milliseconds, and flushed at phase boundaries;
- Sync Center subscriptions are removed on close and progress updates do not reload history;
- progress paths are absent from persisted plugin data and local-index serialization;
- existing sync, encryption, history, migration, and GitHub E2E suites remain green.

