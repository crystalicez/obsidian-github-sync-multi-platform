import assert from "node:assert/strict";
import test from "node:test";

const bytes = new TextEncoder().encode("ภาษาไทย/emoji 🚀").buffer;

function toBase64Url(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  return Buffer.from(data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function fromBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return new Uint8Array(Buffer.from(padded, "base64")).buffer;
}

test("base64url round trips arbitrary UTF-8 bytes", () => {
  const encoded = toBase64Url(bytes);
  assert.equal(encoded.includes("+"), false);
  assert.equal(encoded.includes("/"), false);
  assert.deepEqual(new Uint8Array(fromBase64Url(encoded)), new Uint8Array(bytes));
});
