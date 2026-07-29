import type { V4LocalIo } from "./local-io";

export type V4LocalTrashIo = Pick<V4LocalIo, "trash">;

export async function trashV4LocalUserFile(io: V4LocalTrashIo, path: string): Promise<void> {
  await io.trash(path);
}
