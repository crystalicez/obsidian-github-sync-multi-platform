# V4 Rename-Cycle Causality Design

## Goal

Preserve unknown-base conflict handling when a surviving file identity passes through a queued file or folder rename cycle and ends at its original path, without regressing terminal delete or replacement causality.

## Design

`causalIdentityState()` will record every file identity that passes through a `rename` or `folderRename` while replaying ordered queued changes. Its returned rename-sensitive set will be the intersection of that provenance set and the identities present in the terminal virtual state.

This deliberately separates two facts:

- Rename provenance is historical and remains true even when the final path equals the original path, including coordinator-coalesced `oldPath === path` file renames.
- Terminal survival is current state. An identity removed by a later delete or replacement is excluded from the rename-sensitive set, so its touched base remains available for the causal delete or old-ID delete plus new-ID create.

Unknown-base planner-base filtering will continue to retain a surviving renamed identity only when its local hash equals the authenticated remote hash. Divergent content will therefore remain outside the base and enter the configured conflict policy. Unchanged content will retain causal base evidence and no-op while preserving identity.

## Tests

- Plaintext and encrypted file cycles will pass coordinator-coalesced `A -> B -> A` changes into a recovering unknown-base session. Divergent local content must invoke an explicit `ask` conflict callback that chooses remote, leave the repository and journal set unchanged, preserve the remote identity and object, and remain correct through independent Force Pull.
- Plaintext and encrypted unchanged-content file cycles must no-op without publishing and preserve identity.
- A folder cycle `A -> B -> A` with nested descendants will prove that every surviving descendant receives rename provenance even though it ends under the original root. Divergent content must resolve through conflict policy while unchanged descendants retain their identities.
- Existing terminal rename-then-delete and rename-then-replacement tests remain the regression boundary for the terminal-state intersection.

## Scope

Only causal rename classification and focused regressions change. Coordinator coalescing, planner behavior, conflict policy behavior, storage formats, and remote record layouts remain unchanged.
