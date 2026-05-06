import { describe, it, expect } from "vitest";
import {
  getConsistentResolution,
  getConsistentResolutionWithLog,
  getResolutionPoolSize,
  getViewport,
  listResolutionPool,
} from "./profile-resolution.js";

describe("profile-resolution", () => {
  it("returns the same resolution for the same email", () => {
    const a = getConsistentResolution("user@example.com");
    const b = getConsistentResolution("user@example.com");
    expect(a).toEqual(b);
  });

  it("is case-insensitive and trims whitespace", () => {
    const a = getConsistentResolution("USER@Example.com");
    const b = getConsistentResolution("  user@example.com  ");
    expect(a).toEqual(b);
  });

  it("returns a structurally valid resolution", () => {
    const r = getConsistentResolution("alice@example.com");
    expect(r.width).toBeGreaterThanOrEqual(1024);
    expect(r.height).toBeGreaterThanOrEqual(600);
    expect(r.share).toBeGreaterThan(0);
    expect(typeof r.label).toBe("string");
  });

  it("getViewport strips share/label and returns plain dimensions", () => {
    const r = getConsistentResolution("alice@example.com");
    const vp = getViewport(r);
    expect(Object.keys(vp).sort()).toEqual(["height", "width"]);
    expect(vp.width).toBe(r.width);
    expect(vp.height).toBe(r.height);
  });

  it("logs a summary when logFn is provided", () => {
    const logs: string[] = [];
    getConsistentResolutionWithLog("user@example.com", (m) => logs.push(m));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/Resolution:.*\d+x\d+/);
  });

  it("pool has at least 6 realistic resolutions", () => {
    expect(getResolutionPoolSize()).toBeGreaterThanOrEqual(6);
  });

  it("includes 1920x1080 as the dominant FHD entry", () => {
    const fhd = listResolutionPool().find(r => r.width === 1920 && r.height === 1080);
    expect(fhd).toBeDefined();
  });

  it("share values sum to a sane percentage range", () => {
    const total = listResolutionPool().reduce((s, r) => s + r.share, 0);
    expect(total).toBeGreaterThan(50);
    expect(total).toBeLessThanOrEqual(100);
  });

  it("distributes emails across most resolutions over many samples", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const r = getConsistentResolution(`u${i}@x.com`);
      seen.add(`${r.width}x${r.height}`);
    }
    expect(seen.size).toBe(getResolutionPoolSize());
  });

  it("every pool entry has positive integer dimensions", () => {
    for (const r of listResolutionPool()) {
      expect(Number.isInteger(r.width) && r.width > 0).toBe(true);
      expect(Number.isInteger(r.height) && r.height > 0).toBe(true);
    }
  });
});

