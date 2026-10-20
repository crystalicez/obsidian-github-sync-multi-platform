import { hasGitHubSyncConfig, type SyncPolicySettings } from "../sync-policy"
import { startV4PlatformTimeout } from "./platform-interval"

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
  private retryCancel: (() => void) | null = null

  constructor(private readonly options: {
    desktop: boolean
    now: () => number
    enabled: () => boolean
    isVisible: () => boolean
    isOnline: () => boolean
    run: () => Promise<unknown>
    onError?: (error: unknown) => void
    scheduleRetry?: (callback: () => void, delay: number) => (() => void)
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
    // A large backward system clock correction cannot make a real foreground
    // transition into evidence that no time passed while Obsidian was hidden.
    if (this.hiddenSince !== null
      && (now - this.hiddenSince >= 5_000 || now - this.hiddenSince <= -5_000)) this.request()
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
    const drift = now - this.lastHeartbeatAt
    // Sleep and user/NTP clock corrections may move Date.now in either direction.
    if (this.options.desktop && (drift >= 90_000 || drift <= -30_000)) this.request()
    this.lastHeartbeatAt = now
    this.deliver()
  }

  dispose(): void {
    this.disposed = true
    this.pending = false
    this.clearRetry()
  }

  private clearRetry(): void {
    this.retryCancel?.()
    this.retryCancel = null
  }

  private request(): void {
    this.pending = true
    this.deliver()
  }

  private deliver(): void {
    if (this.disposed || !this.pending || this.running) return
    if (!this.options.enabled()) {
      this.pending = false
      this.clearRetry()
      return
    }
    if (!this.options.isOnline() || (!this.options.desktop && !this.options.isVisible())) return
    const now = this.options.now()
    if (this.lastAttemptAt !== null) {
      const elapsed = now - this.lastAttemptAt
      if (elapsed >= 0 && elapsed < 30_000) {
        if (!this.retryCancel) {
          const callback = () => { this.retryCancel = null; this.deliver() }
          this.retryCancel = this.options.scheduleRetry?.(callback, 30_000 - elapsed)
            ?? startV4PlatformTimeout(this.options.desktop, callback, 30_000 - elapsed)
        }
        return
      }
      // Wall clock corrections must not suppress reconciliation for hours.
    }
    this.clearRetry()
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
