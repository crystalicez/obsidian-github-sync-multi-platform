import { TFile, Vault } from "obsidian";

const TRANSIENT_VAULT_READ_ERROR_CODES = new Set(["EBUSY", "EPERM", "EAGAIN", "EMFILE"]);
const VAULT_READ_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800];

function isTransientVaultReadError(error: unknown): boolean {
  const maybe = error as { code?: string; message?: string };
  return TRANSIENT_VAULT_READ_ERROR_CODES.has(maybe?.code ?? "") || /\b(EBUSY|EPERM|EAGAIN|EMFILE)\b/u.test(maybe?.message ?? "");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => globalThis.setTimeout(resolve, ms));
}

async function retryTransientVaultRead<T>(read: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= VAULT_READ_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (!isTransientVaultReadError(error) || attempt === VAULT_READ_RETRY_DELAYS_MS.length) throw error;
      await sleep(VAULT_READ_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

export async function readVaultFileBytes(vault: Vault, file: TFile): Promise<Uint8Array> {
  return new Uint8Array(await retryTransientVaultRead(() => vault.readBinary(file)));
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
