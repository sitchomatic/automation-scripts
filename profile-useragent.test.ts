import { describe, it, expect } from "vitest";
import {
  getConsistentUserAgent,
  getConsistentUserAgentWithLog,
  getUserAgentArgs,
  getUserAgentPoolSize,
  listUserAgentPool,
} from "./profile-useragent.js";

describe("profile-useragent", () => {
  it("returns the same UA for the same email", () => {
    const a = getConsistentUserAgent("user@example.com");
    const b = getConsistentUserAgent("user@example.com");
    expect(a).toEqual(b);
  });

  it("is case-insensitive and trims whitespace", () => {
    const a = getConsistentUserAgent("USER@Example.com");
    const b = getConsistentUserAgent("  user@example.com  ");
    expect(a).toEqual(b);
  });

  it("returns a structurally valid profile", () => {
    const ua = getConsistentUserAgent("alice@gmail.com");
    expect(ua.ua).toMatch(/Mozilla\/5\.0.*Chrome\/\d+\.\d+\.\d+\.\d+/);
    expect(ua.chromeMajor).toBeGreaterThanOrEqual(133);
    expect(ua.chromeVersion.split(".").length).toBe(4);
    expect(ua.windowsVersion).toMatch(/^10\.0\.\d+$/);
    expect(["Win10", "Win11"]).toContain(ua.windowsLabel);
  });

  it("UA string contains the listed Chrome version", () => {
    const ua = getConsistentUserAgent("bob@gmail.com");
    expect(ua.ua).toContain(`Chrome/${ua.chromeVersion}`);
  });

  it("returns different UAs for different email domains across the pool", () => {
    const seen = new Set<string>();
    const samples = [
      "a@gmail.com", "b@yahoo.com", "c@outlook.com", "d@protonmail.com",
      "e@hotmail.com", "f@icloud.com", "g@live.com", "h@aol.com",
      "i@mail.com", "j@example.org",
    ];
    for (const e of samples) seen.add(getConsistentUserAgent(e).chromeVersion);
    expect(seen.size).toBeGreaterThan(1);
  });

  it("logs a summary when logFn is provided", () => {
    const logs: string[] = [];
    getConsistentUserAgentWithLog("user@example.com", (m) => logs.push(m));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/UA freshness:.*Chrome \d+ on Win1[01]/);
  });

  it("does not log when logFn is omitted", () => {
    expect(() => getConsistentUserAgentWithLog("user@example.com")).not.toThrow();
  });

  it("getUserAgentArgs returns binary fingerprint flags", () => {
    const ua = getConsistentUserAgent("alice@example.com");
    const args = getUserAgentArgs(ua);
    expect(args).toContain(`--fingerprint-platform-version=${ua.windowsVersion}`);
    expect(args).toContain(`--fingerprint-browser-version=${ua.chromeVersion}`);
    expect(args.every((a) => a.startsWith("--fingerprint-"))).toBe(true);
  });

  it("pool has at least 5 contemporary UAs", () => {
    expect(getUserAgentPoolSize()).toBeGreaterThanOrEqual(5);
  });

  it("every pool entry is internally consistent", () => {
    for (const ua of listUserAgentPool()) {
      expect(ua.ua).toContain(`Chrome/${ua.chromeVersion}`);
      expect(ua.chromeVersion.startsWith(`${ua.chromeMajor}.`)).toBe(true);
    }
  });

  it("distributes hashes across the whole pool over many emails", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(getConsistentUserAgent(`u${i}@x.com`).chromeVersion);
    expect(seen.size).toBe(getUserAgentPoolSize());
  });
});

