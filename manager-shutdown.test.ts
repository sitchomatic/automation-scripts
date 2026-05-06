/**
 * Unit tests for manager-shutdown.ts graceful shutdown.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { stopProfile, stopAllProfiles, gracefulShutdown } from "./manager-shutdown.js";
import * as managerCdp from "./manager-cdp.js";
import { profilePool } from "./manager-pool.js";
import { healthMonitor } from "./manager-health.js";

vi.mock("./manager-cdp.js", () => ({
  listProfiles: vi.fn(),
  MANAGER_URL: "http://localhost:8080",
  MANAGER_TOKEN: "",
}));

describe("Shutdown utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should stop a single profile", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    const result = await stopProfile("test-profile", 5000);

    expect(result).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:8080/api/profiles/test-profile/stop",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("should handle profile stop timeout", async () => {
    global.fetch = vi.fn().mockImplementation(
      () =>
        new Promise((_) => {
          // Never resolves
        })
    );

    const result = await stopProfile("test-profile", 100);

    expect(result).toBe(false);
  });

  it("should stop multiple profiles in parallel", async () => {
    vi.mocked(managerCdp.listProfiles).mockResolvedValue([
      { id: "p1", name: "profile-1", status: "running", cdp_url: null },
      { id: "p2", name: "profile-2", status: "running", cdp_url: null },
      { id: "p3", name: "profile-3", status: "stopped", cdp_url: null },
    ]);

    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    const result = await stopAllProfiles(5000, 2);

    expect(result.stopped).toBeGreaterThanOrEqual(0);
    expect(result.failed).toBeGreaterThanOrEqual(0);
  });

  it("should handle listProfiles error", async () => {
    vi.mocked(managerCdp.listProfiles).mockRejectedValue(new Error("API error"));

    const result = await stopAllProfiles(5000, 2);

    expect(result.stopped).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("should perform graceful shutdown", async () => {
    vi.mocked(managerCdp.listProfiles).mockResolvedValue([
      { id: "p1", name: "profile-1", status: "running", cdp_url: null },
    ]);

    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    vi.spyOn(profilePool, "drain").mockResolvedValue(undefined);
    vi.spyOn(healthMonitor, "stop");

    const result = await gracefulShutdown(10_000);

    expect(result.success).toBe(true);
    expect(profilePool.drain).toHaveBeenCalled();
    expect(healthMonitor.stop).toHaveBeenCalled();
  });

  it("should return error message on shutdown failure", async () => {
    vi.mocked(managerCdp.listProfiles).mockRejectedValue(new Error("Connection lost"));

    const result = await gracefulShutdown(5_000);

    expect(result.success).toBe(false);
    expect(result.message).toContain("error");
  });
});

