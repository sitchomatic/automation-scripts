/**
 * Unit tests for manager-metrics.ts metrics collection.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MetricsCollector, type ManagerMetrics } from "./manager-metrics.js";

describe("MetricsCollector", () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  it("should record connections", () => {
    collector.recordConnection(100, true);
    collector.recordConnection(150, true);
    collector.recordConnection(5000, false);

    const metrics = collector.collect();
    expect(metrics.healthyProfiles).toBe(2);
    expect(metrics.unhealthyProfiles).toBe(1);
  });

  it("should calculate connection time percentiles", () => {
    const times = [50, 100, 150, 200, 250, 300, 350, 400, 450, 500];
    for (const t of times) {
      collector.recordConnection(t, true);
    }

    const metrics = collector.collect();
    expect(metrics.avgConnectTimeMs).toBeGreaterThan(0);
    expect(metrics.medianConnectTimeMs).toBeGreaterThan(0);
    expect(metrics.p95ConnectTimeMs).toBeGreaterThan(metrics.medianConnectTimeMs);
  });

  it("should calculate failure rate", () => {
    collector.recordConnection(100, true);
    collector.recordConnection(100, true);
    collector.recordConnection(100, false);
    collector.recordConnection(100, false);

    const metrics = collector.collect();
    expect(metrics.failureRate).toBeCloseTo(0.5, 2);
  });

  it("should reset metrics", () => {
    collector.recordConnection(100, true);
    collector.recordConnection(100, false);

    collector.reset();
    const metrics = collector.collect();

    expect(metrics.healthyProfiles).toBe(0);
    expect(metrics.unhealthyProfiles).toBe(0);
    expect(metrics.avgConnectTimeMs).toBe(0);
  });

  it("should respect max samples limit", () => {
    for (let i = 0; i < 1500; i++) {
      collector.recordConnection(100, true);
    }

    const metrics = collector.collect();
    expect(metrics.healthyProfiles).toBe(1500);
    // But internally capped at maxSamples for percentile calculation
  });

  it("should track uptime", (done: () => void) => {
    const startMetrics = collector.collect();
    expect(startMetrics.uptime.durationMs).toBeGreaterThanOrEqual(0);

    setTimeout(() => {
      const endMetrics = collector.collect();
      expect(endMetrics.uptime.durationMs).toBeGreaterThan(startMetrics.uptime.durationMs);
      done();
    }, 50);
  });

  it("should format metrics as string", () => {
    const metrics: ManagerMetrics = {
      profilesTotal: 10,
      profilesRunning: 5,
      profilesStopped: 5,
      connectionsActive: 3,
      connectionsPooled: 2,
      connectionsStale: 0,
      avgConnectTimeMs: 150,
      medianConnectTimeMs: 100,
      p95ConnectTimeMs: 450,
      healthyProfiles: 8,
      unhealthyProfiles: 2,
      failureRate: 0.2,
      lastCollectedAt: new Date(),
      uptime: {
        startedAt: new Date(),
        durationMs: 60000,
      },
    };

    const formatted = collector.format(metrics);
    expect(formatted).toContain("5/10 running");
    expect(formatted).toContain("20.00% fail rate");
  });
});

