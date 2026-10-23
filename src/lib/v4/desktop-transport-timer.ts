// GitHub transport scheduling only. Do not change UI, autosync or mobile timers.
export function selectV4GitHubSchedulerSleep(
  isDesktop: boolean,
  nodeTimer?: (callback: () => void, milliseconds: number) => unknown,
): ((milliseconds: number) => Promise<void>) | undefined {
  if (!isDesktop) return undefined
  // Resolve the Node builtin only in Obsidian Desktop: a static import could load on mobile.
  const timer = nodeTimer ?? (require("node:timers").setTimeout as (callback: () => void, milliseconds: number) => unknown)
  return milliseconds => new Promise<void>(resolve => { timer(resolve, milliseconds) })
}
