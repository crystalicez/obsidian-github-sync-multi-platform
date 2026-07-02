import { encryptV3BinaryPayload } from "./binary-format";
import { ENCRYPTED_V3_ROOT } from "./protocol-types";

export function encryptedV3ObjectPath(objectId: string): string {
  return `${ENCRYPTED_V3_ROOT}/objects/${objectId.slice(0, 2)}/${objectId.slice(2, 4)}/${objectId}.bin.enc`;
}

export async function encryptV3LooseObject(input: {
  keyMaterial: Uint8Array;
  repoId: string;
  objectId: string;
  plaintext: Uint8Array;
}): Promise<{ path: string; bytes: Uint8Array }> {
  return {
    path: encryptedV3ObjectPath(input.objectId),
    bytes: await encryptV3BinaryPayload(input.keyMaterial, input.plaintext, {
      aad: `${input.repoId}:${input.objectId}`,
      kind: "object",
    }),
  };
}
