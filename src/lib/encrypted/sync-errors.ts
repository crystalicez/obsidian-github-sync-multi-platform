import { Notice } from "obsidian";
import { EncryptedSyncOperation } from "./types";

export class WrongPassphraseError extends Error {
  constructor() {
    super("Encrypted repo could not be decrypted. The passphrase is wrong or the repo was created with another key.");
    this.name = "WrongPassphraseError";
  }
}

export class ForeignRemoteError extends Error {
  constructor() {
    super("Remote repository contains files that do not belong to this encrypted sync plugin.");
    this.name = "ForeignRemoteError";
  }
}

export function userMessageForSyncError(operation: EncryptedSyncOperation, error: unknown, path?: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  const target = path ? ` for ${path}` : "";
  return `Encrypted ${operation} failed${target}: ${detail}`;
}

export function reportSyncError(operation: EncryptedSyncOperation, error: unknown, path?: string): void {
  console.error(`Encrypted ${operation} failed`, { path, error });
  new Notice(userMessageForSyncError(operation, error, path));
}

export function isForeignRemoteError(error: unknown): boolean {
  return error instanceof ForeignRemoteError;
}

export function isWrongPassphraseError(error: unknown): boolean {
  return error instanceof WrongPassphraseError;
}
