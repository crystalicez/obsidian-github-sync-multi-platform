import { GitHubClient } from "../github-api";
import { ENCRYPTED_CONFIG_PATH, ENCRYPTED_ROOT } from "./constants";
import { RemoteRepoState } from "./types";

export async function classifyRemoteRepo(github: GitHubClient): Promise<RemoteRepoState> {
  const tree = await github.getTree().catch(() => null);
  if (tree?.truncated) throw new Error("GitHub tree response was truncated; encrypted sync cannot safely classify this repository.");
  const blobs = tree?.tree.filter(node => node.type === "blob") ?? [];
  if (blobs.length === 0) return { kind: "empty" };
  if (blobs.some(node => node.path === ENCRYPTED_CONFIG_PATH)) return { kind: "encrypted-plugin" };
  if (blobs.some(node => node.path.startsWith(`${ENCRYPTED_ROOT}/`))) {
    return { kind: "corrupt-plugin", message: "Encrypted plugin files exist but config.json is missing." };
  }
  return { kind: "foreign-nonempty", message: "Remote repository is not empty and does not contain this plugin's encrypted metadata." };
}
