import { Modal, TFile } from "obsidian";
import FastSync from "../../main";
import { ConflictPolicy } from "./types";

export type ConflictResolution = "keep-local" | "use-remote" | "copy-remote" | "merged";

export function isTextLikePath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".json") || lower.endsWith(".canvas");
}

export function chooseNewerResolution(localMtime: number | undefined, remoteMtime: number | undefined): ConflictResolution {
  if (!localMtime || !remoteMtime || localMtime === remoteMtime) return "copy-remote";
  return localMtime > remoteMtime ? "keep-local" : "use-remote";
}

export function mergeTextContent(local: string, remote: string): string {
  if (local === remote) return local;
  return `${local}\n\n<<<<<<< remote encrypted sync version\n${remote}\n>>>>>>> remote encrypted sync version\n`;
}

export async function resolveAskConflict(plugin: FastSync, path: string): Promise<ConflictResolution> {
  return new Promise(resolve => {
    const modal = new Modal(plugin.app);
    modal.titleEl.setText(`Sync conflict: ${path}`);
    modal.contentEl.createEl("p", { text: "Choose how to resolve this encrypted sync conflict." });
    const buttons = modal.contentEl.createDiv();
    buttons.createEl("button", { text: "Keep local" }).onclick = () => { modal.close(); resolve("keep-local"); };
    buttons.createEl("button", { text: "Use remote" }).onclick = () => { modal.close(); resolve("use-remote"); };
    buttons.createEl("button", { text: "Copy remote" }).onclick = () => { modal.close(); resolve("copy-remote"); };
    modal.open();
  });
}

export async function chooseConflictResolution(
  plugin: FastSync,
  policy: ConflictPolicy,
  path: string,
  localFile: TFile | null,
  remoteMtime: number | undefined
): Promise<ConflictResolution> {
  if (policy === "newer") return chooseNewerResolution(localFile?.stat.mtime, remoteMtime);
  if (policy === "ask") return resolveAskConflict(plugin, path);
  if (policy === "merge" && isTextLikePath(path)) return "merged";
  return "copy-remote";
}
