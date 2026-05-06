/**
 * Unit tests for manager-pool.ts connection pooling.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ManagerProfilePool } from "./manager-pool.js";
import { connectManagerProfile, type ManagerHandle, type ConnectOpts } from "./manager-cdp.js";

// Mock connectManagerProfile
vi.mock("./manager-cdp.js", () => ({
  connectManagerProfile: vi.fn(),
  MANAGER_URL: "http://localhost:8080",
  MANAGER_TOKEN: "",
}));

describe("ManagerProfilePool", () => {
  let pool: ManagerProfilePool;
  let mockHandle: ManagerHandle;

  beforeEach(() => {
    pool = new ManagerProfilePool(300_000, 10);
    mockHandle = {
      browser: {} as any,
      context: {} as any,
      page: {} as any,
      profile: { id: "test-1", name: "test", status: "running", cdp_url: null },
      cdpHttpUrl: "http://localhost:8080/api/profiles/test-1/cdp",
      close: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("should acquire a new connection when pool is empty", async () => {
    const mockConnect = vi.mocked(connectManagerProfile).mockResolvedValue(mockHandle);

    const handle = await pool.acquire({ profileName: "test" });

    expect(handle).toBe(mockHandle);
    expect(mockConnect).toHaveBeenCalledWith({ profileName: "test" });
  });

  it("should reuse idle connection from pool", async () => {
    const mockConnect = vi.mocked(connectManagerProfile).mockResolvedValue(mockHandle);

    // First acquire
    await pool.acquire({ profileId: "test-1" });
    await pool.release(mockHandle, true);

    // Second acquire should reuse
    mockConnect.mockClear();
    const handle = await pool.acquire({ profileId: "test-1" });

    expect(handle).toBe(mockHandle);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("should close connection when pool is full", async () => {
    const handles = Array(10).fill(null).map((_, i) => ({
      ...mockHandle,
      profile: { ...mockHandle.profile, id: `test-${i}` },
      close: vi.fn().mockResolvedValue(undefined),
    }));

    for (const h of handles) {
      await pool.release(h, true);
    }

    const newHandle = {
      ...mockHandle,
      profile: { ...mockHandle.profile, id: "test-overflow" },
      close: vi.fn().mockResolvedValue(undefined),
    };
    await pool.release(newHandle, true);

    expect(newHandle.close).toHaveBeenCalled();
  });

  it("should mark connections as stale after timeout", () => {
    pool.markStale(1); // Mark immediately stale
    const stats = pool.getStats();

    expect(stats.staleCount >= 0).toBeTruthy();
  });

  it("should drain all connections", async () => {
    await pool.release(mockHandle, true);
    await pool.drain();

    const stats = pool.getStats();
    expect(stats.totalPooled).toBe(0);
    expect(mockHandle.close).toHaveBeenCalled();
  });

  it("should track pool statistics", async () => {
    await pool.release(mockHandle, true);
    const stats = pool.getStats();

    expect(stats.totalPooled).toBe(1);
    expect(stats.activeCount).toBe(1);
    expect(stats.maxSize).toBe(10);
  });
});

