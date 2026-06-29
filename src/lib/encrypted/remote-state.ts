import { GitHubClient } from "../github-api";
import { ENCRYPTED_CONFIG_PATH, ENCRYPTED_ROOT } from "./constants";
import { RemoteRepoState } from "./types";

export async function classifyRemoteRepo(github: GitHubClient): Promise<RemoteRepoState> {
  const config = await github.getFile(ENCRYPTED_CONFIG_PATH);
  if (config) return { kind: "encrypted-plugin" };

  const headSha = await github.getRemoteHeadSha();
  if (!headSha) return { kind: "empty" };

  const folder = await github.getFile(ENCRYPTED_ROOT);
  if (folder) {
    return { kind: "corrupt-plugin", message: "Encrypted plugin files exist but config.json is missing." };
  }

  return { kind: "foreign-nonempty", message: "Remote repository is not empty and does not contain this plugin's encrypted metadata." };
}
