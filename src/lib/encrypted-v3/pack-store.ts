import { decodePackArchive, encodePackArchive, type PackArchiveFileInput, type PackArchiveFileOutput } from "../encrypted/pack-format";
import { decryptV3BinaryPayload, encryptV3BinaryPayload } from "./binary-format";
import { ENCRYPTED_V3_ROOT } from "./protocol-types";

export function encryptedV3BasePackPath(packId: string): string {
  return `${ENCRYPTED_V3_ROOT}/packs/base/${packId}.pack.enc`;
}

export async function encryptV3BasePack(input: {
  keyMaterial: Uint8Array;
  repoId: string;
  packId: string;
  files: PackArchiveFileInput[];
}): Promise<{ path: string; bytes: Uint8Array }> {
  const archive = encodePackArchive(input.files);
  return {
    path: encryptedV3BasePackPath(input.packId),
    bytes: await encryptV3BinaryPayload(input.keyMaterial, archive, {
      aad: `${input.repoId}:${input.packId}:pack`,
      kind: "pack",
    }),
  };
}

export async function decryptV3BasePack(input: {
  keyMaterial: Uint8Array;
  repoId: string;
  packPath: string;
  bytes: Uint8Array;
}): Promise<PackArchiveFileOutput[]> {
  const packId = input.packPath.split("/").at(-1)?.replace(/\.pack\.enc$/u, "") ?? "";
  const archive = await decryptV3BinaryPayload(input.keyMaterial, input.bytes, `${input.repoId}:${packId}:pack`);
  return decodePackArchive(archive);
}
