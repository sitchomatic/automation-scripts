/**
 * Connection pooling for CloakBrowser Manager profiles.
 * Reuses idle connections instead of creating new ones for each session.
 */

import { ManagerHandle, connectManagerProfile, ConnectOpts } from "./manager-cdp.js";

interface ManagedConnection {
  handle: ManagerHandle;
  acquiredAt: number;
  stale: boolean;
}

export class ManagerProfilePool {
  private idle: Map<string, ManagedConnection> = new Map();
  private readonly staleTimeoutMs: number;
  private readonly maxPoolSize: number;

  constructor(staleTimeoutMs = 300_000, maxPoolSize = 10) {
    this.staleTimeoutMs = staleTimeoutMs;
    this.maxPoolSize = maxPoolSize;
  }

  /**
   * Acquire a connection from the pool or create a new one.
   * Marks connections as stale after timeout.
   */
  async acquire(opts: ConnectOpts): Promise<ManagerHandle> {
    const key = opts.profileId || opts.profileName || "default";
    const conn = this.idle.get(key);

    if (conn && !conn.stale && Date.now() - conn.acquiredAt < this.staleTimeoutMs) {
      this.idle.delete(key);
      return conn.handle;
    }

    if (conn && conn.stale) {
      this.idle.delete(key);
      await conn.handle.close().catch(() => {});
    }

    return connectManagerProfile(opts);
  }

  /**
   * Release a connection back to the pool.
   * If keep=false, closes it immediately.
   */
  async release(handle: ManagerHandle, keep = true): Promise<void> {
    if (!keep) {
      await handle.close().catch(() => {});
      return;
    }

    const key = handle.profile.id;
    if (this.idle.size < this.maxPoolSize) {
      this.idle.set(key, {
        handle,
        acquiredAt: Date.now(),
        stale: false,
      });
    } else {
      await handle.close().catch(() => {});
    }
  }

  /**
   * Clear all idle connections and close them.
   */
  async drain(): Promise<void> {
    for (const [, conn] of this.idle) {
      await conn.handle.close().catch(() => {});
    }
    this.idle.clear();
  }

  /**
   * Mark stale connections for cleanup on next acquire.
   */
  markStale(maxAgeMs = 600_000): void {
    const now = Date.now();
    for (const [key, conn] of this.idle) {
      if (now - conn.acquiredAt > maxAgeMs) {
        conn.stale = true;
      }
    }
  }

  /**
   * Get pool statistics.
   */
  getStats() {
    let activeCount = 0;
    let staleCount = 0;
    for (const [, conn] of this.idle) {
      if (conn.stale) staleCount++;
      else activeCount++;
    }
    return {
      totalPooled: this.idle.size,
      activeCount,
      staleCount,
      maxSize: this.maxPoolSize,
    };
  }
}

// Export singleton instance
export const profilePool = new ManagerProfilePool();

