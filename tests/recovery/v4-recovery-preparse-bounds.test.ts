import assert from "node:assert/strict";
import test from "node:test";
import { createV4RecoveryStore, V4RecoveryRequiredError } from "../../src/lib/v4/recovery-store";

function adapter() {
  const values = new Map<string, string>();
  return {
    values,
    async read(path: string) { const value = values.get(path); if (value === undefined) throw Error(path); return value; },
    async write(path: string, value: string) { values.set(path, value); },
    async exists(path: string) { return values.has(path); },
    async mkdir() {},
  };
}

const input = (phase: "publish-intent" | "remote-verified") => ({
  runId: "bounded-recovery",
  phase,
  expectedRemoteHead: "old",
  candidateCommitSha: "candidate",
  verifiedRemoteHead: phase === "remote-verified" ? "candidate" : undefined,
});

test("overlong valid recovery slot cannot be used to bypass the local slot limit", async () => {
  const io = adapter();
  const store = createV4RecoveryStore({ adapter: io, root: "recovery", repoId: "o/r#main" });
  const receipt = await store.save(input("publish-intent"));
  const path = `recovery/slot-${receipt.header.generation % 2}.json`;
  const content = JSON.parse(io.values.get(path)!);
  io.values.set(path, JSON.stringify({ ...content, extra: "x".repeat(33 * 1024 * 1024) }));
  await assert.rejects(store.load(), V4RecoveryRequiredError);
});

test("oversized new recovery receipt is refused without overwriting a valid old slot", async () => {
  const io = adapter();
  const store = createV4RecoveryStore({ adapter: io, root: "recovery", repoId: "o/r#main" });
  const previous = await store.save(input("publish-intent"));
  const before = new Map(io.values);
  await assert.rejects(
    () => store.save({ ...input("remote-verified"), runId: "x".repeat(33 * 1024 * 1024) }),
    V4RecoveryRequiredError,
  );
  assert.deepEqual(io.values, before);
  assert.equal((await store.load())?.header.generation, previous.header.generation);
});

test("recovery stat preflight skips oversized latest slot before adapter read", async () => {
  const backing = adapter();
  const originalStore = createV4RecoveryStore({ adapter: backing, root: "recovery", repoId: "o/r#main" });
  const prior = await originalStore.save(input("publish-intent"));
  const newest = await originalStore.save(input("remote-verified"));
  const newestPath = `recovery/slot-${newest.header.generation % 2}.json`;
  let newerReads = 0;
  const io = {
    ...backing,
    async stat(path: string) { return { size: path === newestPath ? 33 * 1024 * 1024 : backing.values.get(path)!.length }; },
    async read(path: string) {
      if (path === newestPath) newerReads++;
      return backing.read(path);
    },
  };
  const recovered = await createV4RecoveryStore({ adapter: io, root: "recovery", repoId: "o/r#main" }).load();
  assert.equal(recovered?.header.generation, prior.header.generation);
  assert.equal(newerReads, 0);
});

test("older valid recovery generation survives an overlong newer slot", async () => {
  const io = adapter();
  const store = createV4RecoveryStore({ adapter: io, root: "recovery", repoId: "o/r#main" });
  const original = await store.save(input("publish-intent"));
  const latest = await store.save(input("remote-verified"));
  const path = `recovery/slot-${latest.header.generation % 2}.json`;
  io.values.set(path, JSON.stringify({ ...JSON.parse(io.values.get(path)!), extra: "x".repeat(33 * 1024 * 1024) }));
  const recovered = await store.load();
  assert.equal(recovered?.header.generation, original.header.generation);
  assert.equal(recovered?.header.phase, "publish-intent");
});
