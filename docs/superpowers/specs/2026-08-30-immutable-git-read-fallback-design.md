# Immutable Git Read Fallback Design

## Status

Child design of `2026-08-30-release-e2e-runtime-hardening-followup-design.md`.

Repository baseline: `35e98cea924702293bde62d064a83d52eca6d898`.

This child owns the immutable commit-SHA Contents-404 fallback in `GitHubClient` and its scaling/evidence semantics.

## Goal

Recover exact immutable file reads when GitHub Contents temporarily reports 404 without recursively materializing the entire repository tree, while never interpreting truncated or unsupported evidence as confirmed absence.

## Non-goals

This child does not:

- add a retained Git-tree cache,
- change mutable branch-ref Contents semantics,
- redesign history service APIs,
- migrate the repository from SHA-1 object identifiers to another hash algorithm,
- optimize ordinary successful Contents reads,
- treat unsupported Git object modes as normal managed V4 files.

---

# 1. Existing Failure Mode

Current immutable fallback behavior is:

```text
getFileBytes(path, 40-hex commit SHA)
        ↓
Contents API returns 404
        ↓
GET commit
        ↓
GET full recursive tree (?recursive=1)
        ↓
find exact blob path or return null
```

This is correct only when the recursive tree is complete and can materialize far more repository state than required to resolve one path.

The existing code already refuses to treat a truncated recursive response as absence. That fail-closed property must be preserved.

---

# 2. Path-Directed Non-Recursive Traversal

For a requested immutable path:

```text
a/b/c.md
```

resolve:

```text
GET commit SHA
→ root tree SHA
→ GET root tree non-recursive; locate entry "a"
→ require "a" is tree
→ GET tree(a) non-recursive; locate entry "b"
→ require "b" is tree
→ GET tree(b) non-recursive; locate entry "c.md"
→ require final entry is a supported regular blob
→ GET exact blob SHA
```

No immutable-404 fallback request uses `recursive=1`.

Network complexity becomes proportional to path depth rather than repository entry count.

---

# 3. Exact Path Semantics

## 3.1 Do not normalize into a different path

The fallback resolves the exact slash-separated path supplied by the caller.

It does not silently case-fold, Unicode-normalize, collapse `.`/`..`, or otherwise reinterpret path identity.

Invalid/ambiguous path segments that cannot represent an exact repository path under this API should fail clearly rather than be silently normalized.

Ordinary V4 remote object paths are already produced by controlled project code; this rule protects the generic GitHub read boundary from accidental reinterpretation.

## 3.2 Intermediate segments

At an intermediate level:

- exact segment present with `type=tree` → descend,
- exact segment absent and response complete → requested nested file is confirmed absent,
- exact segment absent and response truncated → throw because absence is unknown,
- exact segment present but not a tree → requested deeper path cannot exist below that object; return confirmed absence for the nested file request when the containing tree response is complete.

## 3.3 Final segment

At the containing directory:

- exact final entry absent + complete response → return `null`,
- exact final entry absent + truncated response → throw,
- supported regular blob → fetch exact blob and return it,
- final tree → requested regular file is not present; return `null`,
- final gitlink/submodule (`type=commit` / mode `160000`) → requested regular file is not present; return `null`,
- symlink blob mode `120000` → fail closed as unsupported for this managed-file fallback rather than returning symlink-target text as ordinary file bytes,
- other unsupported mode/type combinations → fail closed with an explicit unsupported-object error.

Supported regular blob modes are the ordinary file modes used by this project (`100644`, and safely `100755` if encountered as a regular blob).

---

# 4. Truncation Is Unknown, Never Absence

For every tree response independently:

```text
requested entry found
→ entry evidence may be used

requested entry not found + truncated=false
→ absence confirmed at this level

requested entry not found + truncated=true
→ throw
```

A complete parent does not make a truncated child complete, and vice versa. The rule is applied at every traversal depth.

The error message should identify that immutable-tree evidence was truncated while resolving the requested path, without pretending the file is missing.

---

# 5. Error Propagation

Unexpected errors from:

- commit lookup,
- tree lookup,
- blob lookup,
- transport/rate limiting,
- malformed Git object data,

propagate rather than becoming `null`.

`null` is reserved for evidence that the requested regular file is genuinely absent/non-file in a complete immutable tree path.

This preserves the distinction:

```text
not found with complete evidence
vs
cannot prove because API/evidence failed
```

---

# 6. No Cache in This Child

Do not add a `Map` or other retained Git-tree cache.

Reasons:

- immutable Contents 404 is a fallback/rare path,
- the project explicitly budgets resident/mobile resources,
- unbounded immutable-tree retention can grow with history browsing/sync activity,
- path-directed traversal already removes the known whole-tree scaling hazard.

If profiling later demonstrates repeated traversal cost is material, design a separate bounded/resource-accounted cache with explicit eviction and memory limits.

---

# 7. Commit Identifier Scope

Current fallback activation recognizes the project's existing 40-hex immutable commit-SHA form.

This child does not broaden commit-object identifier handling or predict a future GitHub repository hash-algorithm migration.

If GitHub/repository object-ID format changes become production-relevant, that requires a separate compatibility design covering all places that assume 40-hex Git object IDs, not a local regex tweak in this fallback alone.

---

# 8. Implementation Boundary

The preferred implementation keeps ordinary Contents behavior unchanged and replaces only the immutable-tree fallback helper.

Conceptually:

```ts
private async getImmutableFileFromTree(
  path: string,
  commitSha: string,
): Promise<{ bytes: Uint8Array; sha: string } | null>
```

internally becomes path-directed and may use a smaller helper such as:

```ts
private async resolveImmutableBlobNode(
  path: string,
  commitSha: string,
): Promise<GitHubTreeNode | null>
```

Exact names are implementation-plan details.

Do not alter mutable-ref 404 behavior:

```text
mutable configured branch + Contents 404 → null
```

The fallback remains specific to immutable commit evidence.

---

# 9. Tests

Extend `tests/v4/github-immutable-read-fallback.test.ts` with focused request-level evidence.

Required cases:

## 9.1 Success

- root-level regular blob,
- deep nested regular blob,
- filenames with spaces/punctuation/Unicode that are exact tree entry names,
- regular executable blob mode `100755` if supported by the implementation contract,
- transient Contents 404 followed by exact path-directed recovery returns expected bytes/blob SHA.

## 9.2 Confirmed absence

- final entry absent in complete containing tree → `null`,
- intermediate entry absent in complete tree → `null`,
- intermediate entry is blob/gitlink instead of tree → `null`,
- final entry is tree → `null`,
- final entry is gitlink → `null`.

## 9.3 Fail closed

- missing entry in truncated root tree → throw,
- missing entry in truncated nested tree → throw,
- final symlink mode `120000` → explicit unsupported/fail-closed result,
- unexpected mode/type combination → throw,
- commit response missing tree SHA → throw,
- tree HTTP/API failure → propagate,
- blob HTTP/API failure → propagate.

## 9.4 Request-shape/scaling assertions

Tests assert:

- no requested URL contains `recursive=1`,
- deep path performs only commit + per-level non-recursive tree lookups + exact blob read,
- unrelated repository subtrees are never requested,
- no retained cache is required for correctness.

---

# 10. Performance and Resource Model

For path depth `d`, fallback network requests are approximately:

```text
1 commit lookup
+ d tree lookups
+ 1 blob lookup on success
```

The response memory footprint is bounded by one non-recursive tree response at a time plus the requested blob, rather than an entire recursive repository tree.

The implementation does not promise constant latency for extremely deep paths, but repository depth is a materially better bound than total repository entries for this use case.

No new resident cache means no new long-lived mobile memory budget is required.

---

# 11. Acceptance Criteria

This child is complete when:

- immutable Contents 404 recovery no longer requests recursive trees,
- exact nested path traversal uses non-recursive trees segment by segment,
- absent entries return `null` only from complete evidence,
- truncation at any unresolved level throws rather than becoming absence,
- intermediate non-tree entries are handled deterministically,
- final tree/gitlink are not returned as regular file bytes,
- symlink/unsupported modes fail closed,
- unexpected commit/tree/blob failures propagate,
- ordinary successful Contents behavior is unchanged,
- mutable branch-ref 404 behavior is unchanged,
- no unbounded tree cache is added,
- request-level regressions prove traversal does not touch unrelated subtrees,
- existing immutable recovery tests remain semantically satisfied with the non-recursive implementation.
