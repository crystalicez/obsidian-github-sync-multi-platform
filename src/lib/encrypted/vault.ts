import { TFile, Vault } from "obsidian";
import { ENCRYPTED_ROOT, MAX_ENCRYPTED_FILE_SIZE } from "./constants";
import { CompiledIgnoreRules, isIgnoredPath } from "./ignore";
import { detectCaseInsensitiveCollisions, normalizeVaultPath } from "./paths";

export function shouldSyncEncryptedFile(file: TFile, ignoreRules?: CompiledIgnoreRules): boolean {
  const path = normalizeVaultPath(file.path);
  if (ignoreRules && isIgnoredPath(path, ignoreRules)) return false;
  if (path.startsWith(`${ENCRYPTED_ROOT}/`)) return false;
  if (path.includes(".sync-conflict-")) return false;
  if (file.stat.size > MAX_ENCRYPTED_FILE_SIZE) return false;
  return true;
}

export function listEncryptedSyncCandidates(vault: Vault, ignoreRules?: CompiledIgnoreRules): TFile[] {
  const files = vault.getFiles().filter(file => shouldSyncEncryptedFile(file, ignoreRules));
  const collisions = detectCaseInsensitiveCollisions(files.map(file => file.path));
  if (collisions.length > 0) {
    throw new Error(`Case-insensitive path collision: ${collisions.map(pair => pair.join(" <-> ")).join(", ")}`);
  }
  return files;
}

export async function readVaultFileBytes(vault: Vault, file: TFile): Promise<Uint8Array> {
  return new Uint8Array(await vault.readBinary(file));
}

async function ensureVaultFolder(vault: Vault, folderPath: string): Promise<void> {
  if (!folderPath) return;
  let current = "";
  for (const part of folderPath.split("/")) {
    current = current ? `${current}/${part}` : part;
    const existing = vault.getAbstractFileByPath(current);
    if (existing instanceof TFile) throw new Error(`Cannot create folder ${current}; a file exists at that path.`);
    if (!existing) await vault.createFolder(current);
  }
}

export async function writeVaultFileBytes(vault: Vault, path: string, bytes: Uint8Array): Promise<void> {
  await ensureVaultFolder(vault, path.split("/").slice(0, -1).join("/"));
  const existing = vault.getAbstractFileByPath(path);
  const buffer = ((bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as ArrayBuffer;
  if (existing instanceof TFile) await vault.modifyBinary(existing, buffer);
  else await vault.createBinary(path, buffer);
}

export async function deleteVaultFileIfExists(vault: Vault, path: string): Promise<void> {
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) await vault.delete(existing);
}
