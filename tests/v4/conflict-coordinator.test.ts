import assert from "node:assert/strict";
import test from "node:test";
import { V4CancelledError } from "../../src/lib/v4/cancellation";
import {
  V4ConflictResolutionCoordinator,
  V4ConflictStaleGenerationError,
} from "../../src/lib/v4/conflict-coordinator";
import type {
  V4ConflictBatchRequest,
  V4ConflictFileResolution,
  V4ConflictFileSummary,
  V4ConflictMaterializedFile,
} from "../../src/lib/v4/conflict-types";

function summary(fileId: string, fingerprint: string, requiresReview = true): V4ConflictFileSummary {
  const side = { exists: true as const, path: `${fileId}.md`, hash: "a".repeat(64), size: 1, mtime: 1 };
  return { fileId, displayPath: side.path, fingerprint, base: side, local: side, remote: side, textCandidate: true, requiresReview };
}

function request(input: {
  generation: number;
  files: V4ConflictFileSummary[];
  runId?: string;
  contextKey?: string;
  materialize?: V4ConflictBatchRequest["materialize"];
}): V4ConflictBatchRequest {
  return {
    runId: input.runId ?? "run-1",
    generation: input.generation,
    contextKey: input.contextKey ?? "ctx-1",
    expectedRemoteHead: "head-1",
    files: input.files,
    materialize: input.materialize ?? (async (fileId, generation) => ({
      generation,
      summary: input.files.find(file => file.fileId === fileId)!,
      mode: "file",
    })),
  };
}

const useLocal = (file: V4ConflictFileSummary): V4ConflictFileResolution => ({
  fileId: file.fileId,
  fingerprint: file.fingerprint,
  kind: "use-local",
});

test("same fingerprint reuses resolution and explicit review across generations", async () => {
  const coordinator = new V4ConflictResolutionCoordinator();
  const file = summary("f", "fp-1");
  const first = coordinator.resolveBatch(request({ generation: 1, files: [file] }));
  coordinator.setResolution(useLocal(file));
  coordinator.markReviewed("f");
  coordinator.continueBatch();
  assert.equal((await first).files[0].kind, "use-local");

  const second = coordinator.resolveBatch(request({ generation: 2, files: [file] }));
  assert.equal(coordinator.snapshot.files[0].resolution?.kind, "use-local");
  assert.equal(coordinator.snapshot.files[0].reviewed, true);
  assert.equal(coordinator.snapshot.canContinue, true);
  coordinator.continueBatch();
  assert.equal((await second).generation, 2);
  coordinator.completeRun("run-1");
});

test("changed fingerprint invalidates the old decision", async () => {
  const coordinator = new V4ConflictResolutionCoordinator();
  const firstFile = summary("f", "fp-1");
  const first = coordinator.resolveBatch(request({ generation: 1, files: [firstFile] }));
  coordinator.setResolution(useLocal(firstFile));
  coordinator.markReviewed("f");
  coordinator.continueBatch();
  await first;

  const changed = summary("f", "fp-2");
  const second = coordinator.resolveBatch(request({ generation: 2, files: [changed] }));
  assert.equal(coordinator.snapshot.files[0].resolution, undefined);
  assert.equal(coordinator.snapshot.files[0].reviewed, false);
  assert.equal(coordinator.snapshot.canContinue, false);
  coordinator.cancel("done");
  await assert.rejects(second, V4CancelledError);
});

test("unsubscribe or view close does not settle the pending batch", async () => {
  const coordinator = new V4ConflictResolutionCoordinator();
  let notifications = 0;
  const unsubscribe = coordinator.subscribe(() => { notifications++; });
  const pending = coordinator.resolveBatch(request({ generation: 1, files: [summary("f", "fp")] }));
  unsubscribe();
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.ok(notifications >= 2);
  coordinator.cancel("user cancelled");
  await assert.rejects(pending, V4CancelledError);
});

test("AbortSignal promptly rejects and clears a pending batch", async () => {
  const coordinator = new V4ConflictResolutionCoordinator();
  const controller = new AbortController();
  const pending = coordinator.resolveBatch(request({ generation: 1, files: [summary("f", "fp")] }), controller.signal);
  controller.abort("shutdown");
  await assert.rejects(pending, error => error instanceof V4CancelledError && /shutdown/u.test(error.message));
  assert.equal(coordinator.snapshot.active, false);
});

test("explicit cancel rejects pending work and clears reusable state", async () => {
  const coordinator = new V4ConflictResolutionCoordinator();
  const file = summary("f", "fp");
  const pending = coordinator.resolveBatch(request({ generation: 1, files: [file] }));
  coordinator.setResolution(useLocal(file));
  coordinator.markReviewed("f");
  coordinator.cancel("stop");
  await assert.rejects(pending, V4CancelledError);
  assert.deepEqual(coordinator.snapshot.files, []);
  assert.equal(coordinator.snapshot.active, false);
});

test("stale materializer completion is rejected after generation advances", async () => {
  const coordinator = new V4ConflictResolutionCoordinator();
  const file = summary("f", "fp");
  let release!: (value: V4ConflictMaterializedFile) => void;
  const deferred = new Promise<V4ConflictMaterializedFile>(resolve => { release = resolve; });
  const firstWait = coordinator.resolveBatch(request({ generation: 1, files: [file], materialize: () => deferred }));
  const loading = coordinator.materialize("f");

  const secondWait = coordinator.resolveBatch(request({ generation: 2, files: [file] }));
  await assert.rejects(firstWait, V4ConflictStaleGenerationError);
  release({ generation: 1, summary: file, mode: "file" });
  await assert.rejects(loading, V4ConflictStaleGenerationError);
  coordinator.cancel("done");
  await assert.rejects(secondWait, V4CancelledError);
});

test("generation advance is rejected for a different run or context", async () => {
  const coordinator = new V4ConflictResolutionCoordinator();
  const file = summary("f", "fp");
  const first = coordinator.resolveBatch(request({ generation: 1, files: [file] }));
  await assert.rejects(
    coordinator.resolveBatch(request({ generation: 2, files: [file], runId: "run-2" })),
    /different V4 conflict run/u,
  );
  await assert.rejects(
    coordinator.resolveBatch(request({ generation: 2, files: [file], contextKey: "ctx-2" })),
    /different V4 conflict context/u,
  );
  coordinator.cancel("done");
  await assert.rejects(first, V4CancelledError);
});

test("continue requires a resolution for every file and explicit review when requested", async () => {
  const coordinator = new V4ConflictResolutionCoordinator();
  const reviewed = summary("review", "fp-r", true);
  const automatic = summary("auto", "fp-a", false);
  const pending = coordinator.resolveBatch(request({ generation: 1, files: [reviewed, automatic] }));
  coordinator.setResolution(useLocal(reviewed));
  coordinator.setResolution(useLocal(automatic));
  assert.throws(() => coordinator.continueBatch(), /review/u);
  coordinator.markReviewed("review");
  coordinator.continueBatch();
  assert.equal((await pending).files.length, 2);
});

test("rejects a resolution carrying a stale fingerprint", async () => {
  const coordinator = new V4ConflictResolutionCoordinator();
  const file = summary("f", "current");
  const pending = coordinator.resolveBatch(request({ generation: 1, files: [file] }));
  assert.throws(() => coordinator.setResolution({ fileId: "f", fingerprint: "stale", kind: "use-local" }), /fingerprint/u);
  coordinator.cancel("done");
  await assert.rejects(pending, V4CancelledError);
});

test("snapshots clone merged bytes so callers cannot mutate the final decision", async () => {
  const coordinator = new V4ConflictResolutionCoordinator();
  const file = summary("f", "fp", false);
  const pending = coordinator.resolveBatch(request({ generation: 1, files: [file] }));
  coordinator.setResolution({ fileId: "f", fingerprint: "fp", kind: "merged", path: "f.md", bytes: new Uint8Array([1, 2]) });
  const visible = coordinator.snapshot.files[0].resolution;
  assert.equal(visible?.kind, "merged");
  if (visible?.kind === "merged") visible.bytes[0] = 9;
  coordinator.continueBatch();
  const result = await pending;
  assert.deepEqual(result.files[0].kind === "merged" ? [...result.files[0].bytes] : [], [1, 2]);
});
