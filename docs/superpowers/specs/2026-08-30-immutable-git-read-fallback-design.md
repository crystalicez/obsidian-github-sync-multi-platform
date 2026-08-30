# Immutable Git Read Fallback Design

## Status

Child design of `2026-08-30-release-e2e-runtime-hardening-followup-design.md` for baseline `35e98cea924702293bde62d064a83d52eca6d898`.

Revised after formal red-team review on 2026-08-30. This child owns the immutable commit-SHA Contents-404 fallback in `GitHubClient`, including complete-evidence semantics and resource scaling.

## Goal

Recover exact immutable managed-file reads when GitHub Contents temporarily returns 404 without recursively materializing the entire repository tree, while never converting truncated, malformed, or unsupported Git-object evidence into a false file-absence result.

## Non-goals

This child does not add a retained Git-tree cache, change mutable branch-ref Contents semantics, redesign history service APIs, broaden Git object-ID algorithms beyond the current project-wide 40-hex assumption, optimize ordinary successful Contents reads, or provide general symlink-following parity with GitHub Contents API.

---

# 1. Existing Failure Mode

Current fallback is:

```text
getFileBytes(path, 40-hex commit SHA)
-> Contents API 404
-> GET commit
-> GET full recursive tree (?recursive=1)
-> find exact blob path or return null
```

The current code correctly refuses to use a truncated recursive tree as proof of absence, but recursively materializing the entire repository is unnecessary and scales with total repository entries rather than requested path depth.

---

# 2. Path-Directed Non-Recursive Traversal

For immutable path:

```text
a/b/c.md
```

resolve:

```text
GET commit SHA
-> require exact commit tree SHA
-> GET root tree non-recursive; locate exact segment "a"
-> require "a" is tree
-> GET tree(a) non-recursive; locate exact segment "b"
-> require "b" is tree
-> GET tree(b) non-recursive; locate exact segment "c.md"
-> require supported regular blob
-> GET exact blob SHA
```

No immutable-404 fallback request uses `recursive=1`.

Network work is proportional to path depth rather than whole repository size.

---

# 3. Exact Path Semantics

The fallback resolves the exact slash-separated path supplied by the caller.

It does not case-fold, Unicode-normalize, collapse `.`/`..`, convert a different path into the requested path, or silently reinterpret ambiguous segments.

Invalid segments fail clearly.

At each tree level, the implementation requires exact segment equality and a unique matching entry. Duplicate exact entry names or malformed entry data are treated as malformed/unsupported evidence and throw rather than selecting one arbitrarily.

---

# 4. Tree Response Evidence Contract

A tree response is acceptable for absence reasoning only when its completeness state is explicit.

For each level independently:

```text
requested segment found
-> use the matching entry even when tree reports truncated=true,
   because existence of that exact returned entry is positive evidence

requested segment not found
AND truncated === false
-> absence is proven at this level

requested segment not found
AND truncated !== false
-> evidence is incomplete/malformed; throw
```

The implementation must test `truncated === false` explicitly. Missing, `null`, non-boolean, or otherwise malformed `truncated` state is not treated as complete evidence.

A complete parent does not make a truncated/malformed child complete, and vice versa.

Tree payload validation also requires the node fields needed for traversal (`path`, `type`, `mode`, `sha`) to have valid expected shapes before they become authority.

---

# 5. Intermediate Segment Semantics

For an intermediate segment:

- exact entry with `type=tree` and valid non-empty SHA -> descend,
- exact segment absent from an explicitly complete tree -> return `null`,
- exact segment absent from truncated/malformed evidence -> throw,
- exact entry exists but is regular blob/gitlink/other non-tree -> deeper regular file cannot exist below that entry; return `null` only when the containing response itself is valid evidence,
- malformed/unsupported entry shape -> throw.

No unrelated subtree is requested.

---

# 6. Final Segment and Managed-Path Object Policy

At the containing directory:

- exact final entry absent + `truncated === false` -> `null`,
- absent + incomplete/malformed completeness evidence -> throw,
- ordinary blob mode `100644` -> fetch exact blob,
- ordinary executable blob mode `100755` -> fetch exact blob,
- final tree -> requested regular file absent, return `null`,
- final gitlink/submodule (`type=commit` / mode `160000`) -> requested regular file absent, return `null`,
- symlink blob mode `120000` -> throw explicit unsupported managed-path object error,
- unsupported/mismatched mode/type combinations -> throw.

The symlink rule is intentional: this fallback is for project-managed immutable remote files. A symlink occupying a managed remote file path is treated as out-of-band/unsupported repository state rather than following the symlink or returning its target text as ordinary managed bytes.

GitHub Contents API may have different general-purpose symlink behavior on a successful non-fallback read; general arbitrary-symlink parity is explicitly outside this child's scope. The fallback's fail-closed symlink behavior is a managed-path integrity boundary, not an accidental claim that all Contents and Git-tree object semantics are identical.

---

# 7. Error Propagation

Unexpected failures from commit lookup, tree lookup, blob lookup, transport/rate limits, malformed Git object data, unsupported managed object modes, or incomplete tree evidence propagate.

`null` is reserved for complete evidence that the requested regular managed file does not exist at that exact immutable tree path.

This preserves:

```text
confirmed absent
!=
cannot prove
```

---

# 8. No Retained Cache

Do not add a retained `Map` or other Git-tree cache in this child.

Reasons:

- immutable Contents 404 is a fallback path,
- the project budgets resident/mobile resources explicitly,
- unbounded historical tree retention can grow with sync/history activity,
- path-directed traversal already removes the known whole-tree scaling problem.

If profiling later proves repeated traversal cost material, design a separate bounded/resource-accounted cache with explicit eviction and memory limits.

---

# 9. Commit Identifier Scope

Fallback activation retains the current project contract for 40-hex immutable commit identifiers.

This child does not locally broaden SHA/object-ID handling. A future GitHub object-hash migration requires a repository-wide compatibility design covering every 40-hex assumption, not a one-off fallback regex change.

---

# 10. Implementation Boundary

Ordinary successful Contents behavior remains unchanged.

Mutable configured branch 404 behavior remains unchanged:

```text
mutable branch + Contents 404 -> null
```

Only the immutable commit-SHA 404 fallback helper changes from recursive full-tree lookup to path-directed traversal.

A small internal resolver may be introduced, but no public API redesign is required.

---

# 11. Tests

## Success

- root-level regular blob,
- deep nested regular blob,
- exact names with spaces/punctuation/Unicode,
- regular executable blob mode `100755`,
- transient Contents 404 followed by exact path traversal returns expected bytes/blob SHA,
- target segment found in a tree that also reports `truncated=true` may still proceed from that positive entry evidence.

## Confirmed absence

- final entry absent in tree with `truncated === false` -> `null`,
- intermediate entry absent in complete tree -> `null`,
- intermediate entry is non-tree -> `null`,
- final tree -> `null`,
- final gitlink -> `null`.

## Fail closed

- missing segment in truncated root -> throw,
- missing segment in truncated nested tree -> throw,
- missing segment when `truncated` missing/null/non-boolean -> throw,
- duplicate exact segment names -> throw,
- malformed node path/type/mode/SHA -> throw,
- final symlink mode `120000` -> explicit unsupported managed-path error,
- unsupported mode/type combination -> throw,
- commit response missing valid tree SHA -> throw,
- tree API failure -> propagate,
- blob API failure -> propagate.

## Request shape/resource

- no requested URL contains `recursive=1`,
- deep success uses one commit lookup + one non-recursive tree lookup per path level + one blob lookup,
- unrelated subtrees are not requested,
- no retained cache is required for correctness.

---

# 12. Performance Model

For path depth `d`, successful fallback is approximately:

```text
1 commit lookup
+ d non-recursive tree lookups
+ 1 blob lookup
```

Memory footprint is bounded by one tree response at a time plus the requested blob rather than an entire recursive repository tree.

The design does not promise constant latency for arbitrarily deep paths; path depth is the intended bound because it is materially smaller and more stable than total repository entry count for this use case.

---

# 13. Acceptance Criteria

Complete only when immutable Contents-404 recovery never requests recursive trees; exact path traversal is segment-by-segment; absence requires explicit `truncated === false`; malformed/truncated evidence never becomes `null`; exact segment matching is unique; ordinary regular blobs work; final tree/gitlink are not returned as file bytes; symlink/unsupported managed objects fail closed by explicit policy; unexpected commit/tree/blob failures propagate; ordinary successful Contents and mutable-ref 404 behavior remain unchanged; no retained tree cache is added; and request-level tests prove unrelated subtrees are untouched.
