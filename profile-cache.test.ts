import { describe, it, expect } from "vitest";
import {
  getCacheProfile,
  getCacheProfileWithLog,
  getCacheInjectionScript,
} from "./profile-cache.js";

describe("profile-cache", () => {
  it("returns the same profile for the same email", () => {
    const a = getCacheProfile("user@example.com");
    const b = getCacheProfile("user@example.com");
    expect(a).toEqual(b);
  });

  it("is case-insensitive and trims whitespace", () => {
    const a = getCacheProfile("USER@Example.com");
    const b = getCacheProfile("  user@example.com  ");
    expect(a).toEqual(b);
  });

  it("lastVisitDaysAgo is in [1,30]", () => {
    for (let i = 0; i < 100; i++) {
      const p = getCacheProfile(`u${i}@x.com`);
      expect(p.lastVisitDaysAgo).toBeGreaterThanOrEqual(1);
      expect(p.lastVisitDaysAgo).toBeLessThanOrEqual(30);
    }
  });

  it("clientId is a UUID-shaped string", () => {
    const p = getCacheProfile("alice@example.com");
    expect(p.clientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("chromeMajor defaults to 136 and is overridable", () => {
    expect(getCacheProfile("a@b.com").chromeMajor).toBe(136);
    expect(getCacheProfile("a@b.com", 137).chromeMajor).toBe(137);
  });

  it("serviceWorkerHint is boolean and roughly 50/50 across samples", () => {
    let trues = 0;
    const N = 200;
    for (let i = 0; i < N; i++) if (getCacheProfile(`u${i}@x.com`).serviceWorkerHint) trues++;
    expect(trues).toBeGreaterThan(N * 0.3);
    expect(trues).toBeLessThan(N * 0.7);
  });

  it("logs a summary when logFn is provided", () => {
    const logs: string[] = [];
    getCacheProfileWithLog("user@example.com", undefined, (m) => logs.push(m));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/Cache:.*last_visit \d+d ago/);
  });

  it("injection script seeds last_visit, browser_version, client_id without clobbering", () => {
    const p = getCacheProfile("alice@example.com");
    const script = getCacheInjectionScript(p);
    expect(script).toContain("setIfAbsent('last_visit'");
    expect(script).toContain("setIfAbsent('browser_version'");
    expect(script).toContain("setIfAbsent('client_id'");
    expect(script).toContain("localStorage.getItem(k) === null");
  });

  it("injection script encodes a recent ISO timestamp for last_visit", () => {
    const p = getCacheProfile("alice@example.com");
    const script = getCacheInjectionScript(p);
    const match = script.match(/setIfAbsent\('last_visit', "([^"]+)"\)/);
    expect(match).not.toBeNull();
    const ts = new Date(match![1]).getTime();
    const now = Date.now();
    expect(now - ts).toBeGreaterThan(0);
    expect(now - ts).toBeLessThan(31 * 86400000);
  });

  it("serviceWorker block only emitted when hint is true", () => {
    const withSW = getCacheInjectionScript({ ...getCacheProfile("alice@example.com"), serviceWorkerHint: true });
    const withoutSW = getCacheInjectionScript({ ...getCacheProfile("alice@example.com"), serviceWorkerHint: false });
    expect(withSW).toContain("caches.open('v1')");
    expect(withoutSW).not.toContain("caches.open('v1')");
  });
});

