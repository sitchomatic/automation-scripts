/**
 * Metrics collection for CloakBrowser Manager integration.
 * Tracks pool usage, connection times, and failure rates for observability.
 */

import { EventEmitter } from "events";

export interface ManagerMetrics {
  // Profile inventory
  profilesTotal: number;
  profilesRunning: number;
  profilesStopped: number;

  // Pool stats
  connectionsActive: number;
  connectionsPooled: number;
  connectionsStale: number;

  // Performance metrics
  avgConnectTimeMs: number;
  medianConnectTimeMs: number;
  p95ConnectTimeMs: number;

  // Health metrics
  healthyProfiles: number;
  unhealthyProfiles: number;
  failureRate: number;

  // Timestamps
  lastCollectedAt: Date;
  uptime: {
    startedAt: Date;
    durationMs: number;
  };
}

export class MetricsCollector extends EventEmitter {
  private connectTimes: number[] = [];
  private healthyCount = 0;
  private unhealthyCount = 0;
  private readonly maxSamples = 1000;
  private startTime = Date.now();

  constructor() {
    super();
  }

  /**
   * Record a connection attempt.
   */
  recordConnection(timeMs: number, healthy: boolean): void {
    this.connectTimes.push(timeMs);
    if (this.connectTimes.length > this.maxSamples) {
      this.connectTimes.shift();
    }

    if (healthy) {
      this.healthyCount++;
    } else {
      this.unhealthyCount++;
    }

    this.emit("connection-recorded", { timeMs, healthy });
  }

  /**
   * Clear all metrics.
   */
  reset(): void {
    this.connectTimes = [];
    this.healthyCount = 0;
    this.unhealthyCount = 0;
    this.startTime = Date.now();
  }

  /**
   * Collect current metrics snapshot.
   */
  collect(poolStats?: any, profileStats?: any): ManagerMetrics {
    const sortedTimes = [...this.connectTimes].sort((a, b) => a - b);
    const avg =
      sortedTimes.length > 0
        ? sortedTimes.reduce((a, b) => a + b, 0) / sortedTimes.length
        : 0;

    const median =
      sortedTimes.length > 0
        ? sortedTimes[Math.floor(sortedTimes.length / 2)]
        : 0;

    const p95 =
      sortedTimes.length > 0
        ? sortedTimes[Math.floor(sortedTimes.length * 0.95)]
        : 0;

    const totalAttempts = this.healthyCount + this.unhealthyCount;
    const failureRate = totalAttempts > 0 ? this.unhealthyCount / totalAttempts : 0;

    return {
      profilesTotal: profileStats?.total || 0,
      profilesRunning: profileStats?.running || 0,
      profilesStopped: profileStats?.stopped || 0,

      connectionsActive: poolStats?.activeCount || 0,
      connectionsPooled: poolStats?.totalPooled || 0,
      connectionsStale: poolStats?.staleCount || 0,

      avgConnectTimeMs: Math.round(avg * 100) / 100,
      medianConnectTimeMs: median,
      p95ConnectTimeMs: p95,

      healthyProfiles: this.healthyCount,
      unhealthyProfiles: this.unhealthyCount,
      failureRate: Math.round(failureRate * 10000) / 10000,

      lastCollectedAt: new Date(),
      uptime: {
        startedAt: new Date(this.startTime),
        durationMs: Date.now() - this.startTime,
      },
    };
  }

  /**
   * Format metrics as a human-readable string.
   */
  format(metrics: ManagerMetrics): string {
    return `
    === Manager Metrics ===
    Profiles: ${metrics.profilesRunning}/${metrics.profilesTotal} running
    Pool: ${metrics.connectionsPooled} pooled, ${metrics.connectionsActive} active, ${metrics.connectionsStale} stale
    Connect Time: avg=${metrics.avgConnectTimeMs}ms, p95=${metrics.p95ConnectTimeMs}ms
    Health: ${metrics.healthyProfiles} healthy, ${metrics.unhealthyProfiles} unhealthy (${(metrics.failureRate * 100).toFixed(2)}% fail rate)
    Uptime: ${Math.round(metrics.uptime.durationMs / 1000)}s
    `;
  }
}

// Export singleton instance
export const metricsCollector = new MetricsCollector();

