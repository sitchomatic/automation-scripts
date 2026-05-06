/**
 * Unit tests for manager-config.ts configuration validation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadManagerConfig,
  getManagerConfig,
  resetManagerConfig,
  formatConfig,
  type ManagerConfig,
} from "./manager-config.js";

describe("ManagerConfig", () => {
  beforeEach(() => {
    resetManagerConfig();
    // Clear env vars
    delete process.env.MANAGER_URL;
    delete process.env.MANAGER_TOKEN;
    delete process.env.MANAGER_CONNECT_TIMEOUT;
    delete process.env.MANAGER_MAX_RETRIES;
    delete process.env.MANAGER_RETRY_DELAY;
  });

  afterEach(() => {
    resetManagerConfig();
  });

  it("should load config with defaults", () => {
    const cfg = loadManagerConfig();

    expect(cfg.url).toBe("http://localhost:8080");
    expect(cfg.connectTimeoutMs).toBe(10000);
    expect(cfg.maxRetries).toBe(3);
    expect(cfg.retryDelayMs).toBe(2000);
    expect(cfg.maxPoolSize).toBe(10);
  });

  it("should load config from environment variables", () => {
    process.env.MANAGER_URL = "http://custom:9000";
    process.env.MANAGER_TOKEN = "secret-token";
    process.env.MANAGER_CONNECT_TIMEOUT = "5000";
    process.env.MANAGER_MAX_RETRIES = "5";

    const cfg = loadManagerConfig();

    expect(cfg.url).toBe("http://custom:9000");
    expect(cfg.token).toBe("secret-token");
    expect(cfg.connectTimeoutMs).toBe(5000);
    expect(cfg.maxRetries).toBe(5);
  });

  it("should strip trailing slash from URL", () => {
    process.env.MANAGER_URL = "http://localhost:8080///";

    const cfg = loadManagerConfig();

    expect(cfg.url).toBe("http://localhost:8080");
  });

  it("should validate timeout range", () => {
    process.env.MANAGER_CONNECT_TIMEOUT = "50"; // Too low

    expect(() => loadManagerConfig()).toThrow();
  });

  it("should validate retry count range", () => {
    process.env.MANAGER_MAX_RETRIES = "20"; // Too high

    expect(() => loadManagerConfig()).toThrow();
  });

  it("should validate pool size range", () => {
    process.env.MANAGER_POOL_SIZE = "0"; // Too low

    expect(() => loadManagerConfig()).toThrow();
  });

  it("should cache config on getManagerConfig call", () => {
    const cfg1 = getManagerConfig();
    process.env.MANAGER_URL = "http://different:8000";
    const cfg2 = getManagerConfig();

    expect(cfg1.url).toBe(cfg2.url); // Should return cached version
  });

  it("should reset cache when resetManagerConfig called", () => {
    getManagerConfig();
    resetManagerConfig();

    process.env.MANAGER_URL = "http://new:8000";
    const cfg = getManagerConfig();

    expect(cfg.url).toBe("http://new:8000");
  });

  it("should format config as readable string", () => {
    const cfg: ManagerConfig = {
      url: "http://localhost:8080",
      token: "my-token",
      connectTimeoutMs: 10000,
      maxRetries: 3,
      retryDelayMs: 2000,
      staleTimeoutMs: 300000,
      maxPoolSize: 10,
      healthCheckIntervalMs: 30000,
      enableMetrics: true,
      enableHealthMonitor: true,
    };

    const formatted = formatConfig(cfg);

    expect(formatted).toContain("http://localhost:8080");
    expect(formatted).toContain("token provided");
    expect(formatted).toContain("connect=10000ms");
    expect(formatted).toContain("max=3");
  });

  it("should require MANAGER_URL", () => {
    process.env.MANAGER_URL = "";

    expect(() => loadManagerConfig()).toThrow("MANAGER_URL is required");
  });
});

