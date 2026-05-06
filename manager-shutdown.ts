/**
 * Graceful shutdown utilities for CloakBrowser Manager profiles.
 * Ensures profiles are properly stopped and resources are cleaned up.
 */

import { listProfiles, MANAGER_URL, MANAGER_TOKEN } from "./manager-cdp.js";
import { profilePool } from "./manager-pool.js";
import { healthMonitor } from "./manager-health.js";

/**
 * Stop a single profile via the Manager API.
 */
export async function stopProfile(profileId: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (MANAGER_TOKEN) {
      headers["Authorization"] = `Bearer ${MANAGER_TOKEN}`;
    }

    const res = await fetch(
      `${MANAGER_URL}/api/profiles/${profileId}/stop`,
      {
        method: "POST",
        headers,
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);
    return res.ok;
  } catch (err: any) {
    console.error(`[Shutdown] Failed to stop profile ${profileId}:`, err.message);
    return false;
  }
}

/**
 * Stop all running profiles.
 * Useful after automation completes to free host resources.
 */
export async function stopAllProfiles(
  timeoutPerProfileMs = 5000,
  parallelLimit = 3
): Promise<{ stopped: number; failed: number }> {
  try {
    const profiles = await listProfiles();
    const running = profiles.filter((p) => p.status === "running");

    console.log(`[Shutdown] Stopping ${running.length} profiles...`);

    let stopped = 0;
    let failed = 0;

    // Stop in batches to avoid overwhelming the Manager
    for (let i = 0; i < running.length; i += parallelLimit) {
      const batch = running.slice(i, i + parallelLimit);
      const results = await Promise.all(
        batch.map((p) => stopProfile(p.id, timeoutPerProfileMs))
      );

      stopped += results.filter((r) => r).length;
      failed += results.filter((r) => !r).length;
    }

    console.log(`[Shutdown] Stopped ${stopped}, failed ${failed}`);
    return { stopped, failed };
  } catch (err: any) {
    console.error("[Shutdown] Failed to list profiles:", err.message);
    return { stopped: 0, failed: 0 };
  }
}

/**
 * Graceful shutdown handler.
 * Drains the pool, stops health monitor, and stops all profiles.
 */
export async function gracefulShutdown(
  timeoutMs = 30_000
): Promise<{ success: boolean; message: string }> {
  const startTime = Date.now();

  try {
    console.log("[Shutdown] Starting graceful shutdown...");

    // Stop health monitor first
    healthMonitor.stop();
    console.log("[Shutdown] Health monitor stopped");

    // Drain connection pool
    await profilePool.drain();
    console.log("[Shutdown] Connection pool drained");

    // Stop all profiles on the Manager
    const { stopped, failed } = await stopAllProfiles(5000, 5);

    const duration = Date.now() - startTime;
    const message = `Gracefully shut down: ${stopped} profiles stopped, ${failed} failed (${duration}ms)`;
    console.log(`[Shutdown] ${message}`);

    return { success: failed === 0, message };
  } catch (err: any) {
    const duration = Date.now() - startTime;
    const message = `Shutdown error after ${duration}ms: ${err.message}`;
    console.error(`[Shutdown] ${message}`);
    return { success: false, message };
  }
}

/**
 * Register shutdown handlers for common signals.
 * Ensures graceful cleanup on process exit.
 */
export function registerShutdownHandlers(): void {
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"];

  for (const signal of signals) {
    process.on(signal, async () => {
      console.log(`\n[Shutdown] Received ${signal}`);
      const result = await gracefulShutdown(30_000);
      process.exit(result.success ? 0 : 1);
    });
  }

  // Catch uncaught exceptions
  process.on("uncaughtException", async (err) => {
    console.error("[Shutdown] Uncaught exception:", err);
    await gracefulShutdown(10_000).catch(() => {});
    process.exit(1);
  });
}

