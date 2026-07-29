import assert from "node:assert/strict";

export async function waitForCondition(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}
