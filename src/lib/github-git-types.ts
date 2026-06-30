export interface GitHubGitRef {
  ref: string;
  sha: string;
  type: string;
}

export interface GitHubCreateTreeEntry {
  path: string;
  mode: "100644" | "100755" | "040000" | "160000" | "120000";
  type: "blob" | "tree" | "commit";
  sha?: string | null;
  content?: string;
}

export interface GitHubCreateCommitResult {
  sha: string;
}

export interface GitHubCreateTreeResult {
  sha: string;
}

export interface GitHubGitCommit {
  sha: string;
  treeSha: string;
  parentShas: string[];
}