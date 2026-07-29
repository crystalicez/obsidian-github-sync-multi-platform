import assert from "node:assert/strict";
import test from "node:test";

import { boundedMap } from "../../src/lib/v4/bounded-map";
import { V4ByteCache } from "../../src/lib/v4/byte-cache";
import {
  createV4ResourceController,
  estimateV4GitBlobTransportBytes,
  V4ResourceReservationTooLargeError,
} from "../../src/lib/v4/resource-controller";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

const limits = {
  maxVaultReads: 2,
  maxCryptoJobs: 1,
  maxResidentBytes: 3,
  maxCacheBytes: 4,
  maxPackPlaintextBytes: 32,
  maxTransportTransientBytes: 8,
};

test("resource controller wakes weighted resident reservations in FIFO order", async () => {
  const resources = createV4ResourceController(limits);
  const holdFirst = deferred();
  const holdSecond = deferred();
  const events: string[] = [];

  const first = resources.withResidentBytes(3, async () => {
    events.push("first:start");
    await holdFirst.promise;
    events.push("first:end");
  });
  await new Promise<void>(resolve => setImmediate(resolve));

  const second = resources.withResidentBytes(3, async () => {
    events.push("second:start");
    await holdSecond.promise;
    events.push("second:end");
  });
  const third = resources.withResidentBytes(1, async () => { events.push("third:start"); });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);

  holdFirst.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);

  holdSecond.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end", "third:start"]);
});

test("resource controller releases capacity when a task rejects", async () => {
  const resources = createV4ResourceController(limits);
  await assert.rejects(resources.withCrypto(async () => { throw new Error("cancelled"); }), /cancelled/u);
  let ran = false;
  await resources.withCrypto(async () => { ran = true; });
  assert.equal(ran, true);
});

test("resource controller rejects an impossible weighted reservation immediately", async () => {
  const resources = createV4ResourceController(limits);
  const started = Date.now();
  await assert.rejects(
    resources.withResidentBytes(4, async () => {}),
    error => error instanceof V4ResourceReservationTooLargeError
      && error.resource === "resident-bytes"
      && error.requested === 4
      && error.maximum === 3,
  );
  assert.ok(Date.now() - started < 100);
});

test("bounded map limits concurrency and preserves input order", async () => {
  let active = 0;
  let peak = 0;
  const values = Array.from({ length: 20 }, (_, index) => index);
  const results = await boundedMap(values, 3, async value => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>(resolve => setImmediate(resolve));
    active--;
    return value * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(results, values.map(value => value * 2));
});

test("byte cache is byte bounded, evicts oldest entries, and supports ownership transfer", () => {
  const cache = new V4ByteCache(4);
  assert.equal(cache.set("a", new Uint8Array([1, 2])), true);
  assert.equal(cache.set("b", new Uint8Array([3, 4])), true);
  assert.equal(cache.byteLength, 4);
  assert.equal(cache.set("c", new Uint8Array([5, 6])), true);
  assert.equal(cache.has("a"), false);
  assert.equal(cache.has("b"), true);
  assert.equal(cache.has("c"), true);
  assert.equal(cache.byteLength, 4);

  const owned = cache.take("b");
  assert.deepEqual([...owned!], [3, 4]);
  assert.equal(cache.byteLength, 2);
  assert.equal(cache.set("oversize", new Uint8Array(5)), false);
  assert.equal(cache.has("oversize"), false);
});


test("Git blob transport reservation uses the Phase-0 raw plus base64 plus JSON amplification model", () => {
  assert.equal(estimateV4GitBlobTransportBytes(3), 78);
  assert.equal(estimateV4GitBlobTransportBytes(48 * 1024 * 1024) > 48 * 1024 * 1024 * 4, true);
});
