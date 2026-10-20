import { hasGitHubSyncConfig, type SyncPolicySettings } from "../sync-policy"

export function shouldRunV4AutomaticWake(settings: SyncPolicySettings & { syncOnLocalChange?: boolean }): boolean {
  return Boolean(settings.syncEnabled && hasGitHubSyncConfig(settings)
    && (settings.syncOnLocalChange || settings.scheduledSyncEnabled))
}

/**
 * Coalesce hints that Obsidian may have missed changes while sleeping. A wake
 * never forces a publish, never aborts the active run, and delegates to the
 * existing V4 coordinator/recovery reconciliation.
 */
export class V4AutomaticWake {
  private hiddenSince: number | null
  private lastHeartbeatAt: number
  private lastAttemptAt: number | null = null
  private wasOffline = false
  private pending = false
  private running = false
  private disposed = false

  constructor(private readonly options: {
    desktop: boolean
    now: () => number
    enabled: () => boolean
    isVisible: () => boolean
    isOnline: () => boolean
    run: () => Promise<unknown>
    onError?: (error: unknown) => void
  }) {
    const now = options.now()
    this.hiddenSince = options.isVisible() ? null : now
    this.wasOffline = !options.isOnline()
    this.lastHeartbeatAt = now
  }

  onVisibilityChanged(): void {
    if (this.disposed) return
    const now = this.options.now()
    if (!this.options.isVisible()) {
      this.hiddenSince ??= now
      return
    }
    if (this.hiddenSince !== null && now - this.hiddenSince >= 5_000) this.request()
    this.hiddenSince = null
    this.deliver()
  }

  onForeground(): void {
    this.onVisibilityChanged()
  }

  onNetworkChanged(online = this.options.isOnline()): void {
    if (this.disposed) return
    if (!online) {
      this.wasOffline = true
      return
    }
    if (this.wasOffline) {
      this.wasOffline = false
      this.request()
    }
    this.deliver()
  }

  onHeartbeat(): void {
    if (this.disposed) return
    const now = this.options.now()
    if (this.options.desktop && now - this.lastHeartbeatAt >= 90_000) this.request()
    this.lastHeartbeatAt = now
    this.deliver()
  }

  dispose(): void {
    this.disposed = true
    this.pending = false
  }

  private request(): void {
    this.pending = true
    this.deliver()
  }

  private deliver(): void {
    if (this.disposed || !this.pending || this.running) return
    if (!this.options.enabled()) {
      this.pending = false
      return
    }
    if (!this.options.isOnline() || (!this.options.desktop && !this.options.isVisible())) return
    const now = this.options.now()
    if (this.lastAttemptAt !== null && now - this.lastAttemptAt < 30_000) return
    this.pending = false
    this.running = true
    this.lastAttemptAt = now
    void Promise.resolve().then(() => {
      if (!this.disposed && this.options.enabled()
        && this.options.isOnline() && (this.options.desktop || this.options.isVisible())) {
        return this.options.run()
      }
    }).catch(error => this.options.onError?.(error)).finally(() => {
      this.running = false
      this.deliver()
    })
  }
}
