export interface V4ActiveSyncStatusInput {
  pushCount: number;
  totalPush: number;
  pullCount: number;
  totalPull: number;
}

export interface V4StatusDisplay {
  text: string;
  title: string;
}

export function formatV4ActiveSyncStatus(input: V4ActiveSyncStatusInput): V4StatusDisplay {
  if (input.totalPush === 0 && input.totalPull === 0) {
    return {
      text: "⏳ GH Sync: Checking remote...",
      title: "GitHub Sync: Checking remote and planning changes...",
    };
  }
  return {
    text: `⏳ GH Sync: ↑${input.pushCount}/${input.totalPush} ↓${input.pullCount}/${input.totalPull}`,
    title: "GitHub Sync: Syncing in progress...",
  };
}
