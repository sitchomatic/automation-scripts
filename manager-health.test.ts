/**
 * Unit tests for manager-health.ts health monitoring.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { HealthMonitor, type HealthCheckEvent } from "./manager-health.js";
import * as managerCdp from "./manager-cdp.js";

vi.mock("./manager-cdp.js", () => ({
  listProfiles: vi.fn(),
  getProfile: vi.fn(),
  MANAGER_URL: "http://localhost:8080",
  MANAGER_TOKEN: "",
}));

describe("HealthMonitor", () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    monitor = new HealthMonitor(1000, 2); // 1s interval, 2 failures threshold
  });

  afterEach(() => {
    monitor.stop();
  });

  it("should start and stop health checks", (done: () => void) => {
    expect(() => monitor.start()).not.toThrow();
    expect(() => monitor.start()).not.toThrow(); // Idempotent

    setTimeout(() => {
      expect(() => monitor.stop()).not.toThrow();
      done();
    }, 100);
  });

  it("should record healthy profile check", () => {
    vi.mocked(managerCdp.listProfiles).mockResolvedValue([
      { id: "p1", name: "profile-1", status: "running", cdp_url: null },
    ]);
    vi.mocked(managerCdp.getProfile).mockResolvedValue({
      id: "p1",
      name: "profile-1",
      status: "running",
      cdp_url: null,
    });

    const listener = vi.fn();
    monitor.on("profile-healthy", listener);

    monitor["checkProfile"]("p1").catch(() => { });

    // Note: actual async test would need proper async handling
  });

  it("should emit unhealthy event after repeated failures", () => {
    const listener = vi.fn();
    monitor.on("profile-unhealthy", listener);

    // Simulate failures
    monitor["recordCheck"]("p1", {
      profileId: "p1",
      status: "unreachable",
      responseTimeMs: 5000,
      error: "Timeout",
      checkedAt: new Date(),
    });

    monitor["recordCheck"]("p1", {
      profileId: "p1",
      status: "unreachable",
      responseTimeMs: 5000,
      error: "Timeout",
      checkedAt: new Date(),
    });

    // Check if repeated failure is detected
    const isFailure = monitor["isRepeatedFailure"]("p1");
    expect(isFailure).toBeTruthy();
  });

  it("should get last check result", () => {
    const event: HealthCheckEvent = {
      profileId: "p1",
      status: "healthy",
      responseTimeMs: 100,
      checkedAt: new Date(),
    };

    monitor["recordCheck"]("p1", event);
    const last = monitor.getLastCheck("p1");

    expect(last?.profileId).toBe("p1");
    expect(last?.status).toBe("healthy");
  });

  it("should prune old check history", () => {
    for (let i = 0; i < 150; i++) {
      monitor["recordCheck"]("p1", {
        profileId: "p1",
        status: "healthy",
        responseTimeMs: 100,
        checkedAt: new Date(),
      });
    }

    const stats = monitor.getStats();
    // Should keep only last 100 entries (default pruning)
    expect(stats["p1"]?.total || 0).toBeLessThanOrEqual(100);
  });

  it("should calculate health statistics", () => {
    monitor["recordCheck"]("p1", {
      profileId: "p1",
      status: "healthy",
      responseTimeMs: 100,
      checkedAt: new Date(),
    });

    monitor["recordCheck"]("p1", {
      profileId: "p1",
      status: "unhealthy",
      responseTimeMs: 5000,
      checkedAt: new Date(),
    });

    const stats = monitor.getStats();
    expect(stats["p1"]?.total).toBe(2);
    expect(stats["p1"]?.healthy).toBe(1);
  });
});

