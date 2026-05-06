/**
 * Health checks for CloakBrowser Manager profiles.
 * Periodically monitors profile connectivity and emits events for auto-recovery.
 */

import { listProfiles, getProfile, MANAGER_URL, MANAGER_TOKEN } from "./manager-cdp.js";
import { EventEmitter } from "events";

export interface HealthCheckEvent {
  profileId: string;
  status: "healthy" | "unhealthy" | "unreachable";
  error?: string;
  responseTimeMs: number;
  checkedAt: Date;
}

export class HealthMonitor extends EventEmitter {
  private intervalId: NodeJS.Timeout | null = null;
  private lastChecks: Map<string, HealthCheckEvent> = new Map();
  private failureThreshold: number;

  constructor(private readonly checkIntervalMs = 30_000, failureThreshold = 2) {
    super();
    this.failureThreshold = failureThreshold;
  }

  /**
   * Start periodic health checks.
   */
  start(): void {
    if (this.intervalId) return;
    console.log(`[HealthMonitor] Starting checks every ${this.checkIntervalMs}ms`);

    this.intervalId = setInterval(() => {
      this.checkAllProfiles().catch((err) => {
        console.error("[HealthMonitor] Check failed:", err.message);
      });
    }, this.checkIntervalMs);
  }

  /**
   * Stop periodic health checks.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[HealthMonitor] Stopped");
    }
  }

  /**
   * Check all running profiles.
   */
  private async checkAllProfiles(): Promise<void> {
    try {
      const profiles = await listProfiles();
      const running = profiles.filter((p) => p.status === "running");

      for (const profile of running) {
        await this.checkProfile(profile.id);
      }
    } catch (err: any) {
      console.error("[HealthMonitor] Failed to list profiles:", err.message);
    }
  }

  /**
   * Check a single profile's health via API call.
   */
  private async checkProfile(profileId: string): Promise<void> {
    const startTime = Date.now();
    try {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), 5000)
      );
      await Promise.race([getProfile(profileId), timeout]);

      const event: HealthCheckEvent = {
        profileId,
        status: "healthy",
        responseTimeMs: Date.now() - startTime,
        checkedAt: new Date(),
      };

      this.recordCheck(profileId, event);
      this.emit("profile-healthy", event);
    } catch (err: any) {
      const event: HealthCheckEvent = {
        profileId,
        status: "unreachable",
        error: err.message,
        responseTimeMs: Date.now() - startTime,
        checkedAt: new Date(),
      };

      this.recordCheck(profileId, event);

      if (this.isRepeatedFailure(profileId)) {
        console.error(
          `[HealthMonitor] Profile ${profileId} failed ${this.failureThreshold} checks — emitting recovery event`
        );
        this.emit("profile-unhealthy", event);
      }
    }
  }

  /**
   * Check if a profile has failed multiple consecutive checks.
   */
  private isRepeatedFailure(profileId: string): boolean {
    const recent = Array.from(this.lastChecks.values())
      .filter((e) => e.profileId === profileId)
      .slice(-this.failureThreshold);

    return (
      recent.length >= this.failureThreshold &&
      recent.every((e) => e.status !== "healthy")
    );
  }

  /**
   * Record a health check result.
   */
  private recordCheck(profileId: string, event: HealthCheckEvent): void {
    this.lastChecks.set(`${profileId}-${Date.now()}`, event);
    // Prune old entries (keep last 100 checks)
    if (this.lastChecks.size > 100) {
      const oldest = Array.from(this.lastChecks.entries())
        .sort(([, a], [, b]) => a.checkedAt.getTime() - b.checkedAt.getTime())
        .slice(0, this.lastChecks.size - 100);
      for (const [key] of oldest) {
        this.lastChecks.delete(key);
      }
    }
  }

  /**
   * Get last check result for a profile.
   */
  getLastCheck(profileId: string): HealthCheckEvent | undefined {
    const matches = Array.from(this.lastChecks.values()).filter(
      (e) => e.profileId === profileId
    );
    return matches[matches.length - 1];
  }

  /**
   * Get stats on all profiles' health.
   */
  getStats() {
    const byProfile = new Map<string, HealthCheckEvent[]>();
    for (const event of this.lastChecks.values()) {
      if (!byProfile.has(event.profileId)) byProfile.set(event.profileId, []);
      byProfile.get(event.profileId)!.push(event);
    }

    const stats: Record<string, any> = {};
    for (const [profileId, events] of byProfile) {
      const healthy = events.filter((e) => e.status === "healthy").length;
      stats[profileId] = {
        total: events.length,
        healthy,
        healthyRate: ((healthy / events.length) * 100).toFixed(1) + "%",
      };
    }
    return stats;
  }
}

// Export singleton instance
export const healthMonitor = new HealthMonitor();

