import { V4ProgressStore, type V4SyncProgressPatch } from "../../src/lib/v4/progress";

declare const store: V4ProgressStore;

type BeginRunPatch = NonNullable<Parameters<V4ProgressStore["beginRun"]>[0]>;
type BeginRunLifecycle = NonNullable<BeginRunPatch["lifecycle"]>;
const beginRunLifecycleIsImpossible: [BeginRunLifecycle] extends [never] ? true : false = true;
void beginRunLifecycleIsImpossible;

store.beginRun({ phase: "planning" });

// @ts-expect-error A successful run must be created by a terminal transition, not beginRun.
store.beginRun({ lifecycle: "success" });
// @ts-expect-error A no-change run must be created by a terminal transition, not beginRun.
store.beginRun({ lifecycle: "no-change" });
// @ts-expect-error A failed run must be created by a terminal transition, not beginRun.
store.beginRun({ lifecycle: "failed" });

const successfulPatch: V4SyncProgressPatch = { lifecycle: "success" };
const noChangePatch: V4SyncProgressPatch = { lifecycle: "no-change" };
const failedPatch: V4SyncProgressPatch = { lifecycle: "failed" };
// @ts-expect-error Pre-typed terminal patches must not bypass the beginRun lifecycle contract.
store.beginRun(successfulPatch);
// @ts-expect-error Pre-typed terminal patches must not bypass the beginRun lifecycle contract.
store.beginRun(noChangePatch);
// @ts-expect-error Pre-typed terminal patches must not bypass the beginRun lifecycle contract.
store.beginRun(failedPatch);
