import { describe, it, expect } from "vitest";
import {
  getFontProfile,
  getFontProfileWithLog,
  getFontsByName,
  listFontProfileNames,
} from "./profile-fonts.js";

describe("profile-fonts", () => {
  it("returns the same profile for the same email", () => {
    const a = getFontProfile("user@example.com");
    const b = getFontProfile("user@example.com");
    expect(a).toEqual(b);
  });

  it("is case-insensitive and trims whitespace", () => {
    const a = getFontProfile("USER@Example.com");
    const b = getFontProfile("  user@example.com  ");
    expect(a).toEqual(b);
  });

  it("returns one of the known profile names", () => {
    const fp = getFontProfile("alice@example.com");
    expect(["minimal", "typical-user", "heavy-user"]).toContain(fp.name);
  });

  it("font list is non-empty and consists of strings", () => {
    const fp = getFontProfile("alice@example.com");
    expect(fp.fonts.length).toBeGreaterThan(0);
    expect(fp.fonts.every((f) => typeof f === "string" && f.length > 0)).toBe(true);
  });

  it("returned font array is a defensive copy", () => {
    const fp = getFontProfile("alice@example.com");
    const before = fp.fonts.length;
    fp.fonts.push("MUTATED");
    const fresh = getFontProfile("alice@example.com");
    expect(fresh.fonts.length).toBe(before);
  });

  it("logs a summary when logFn is provided", () => {
    const logs: string[] = [];
    getFontProfileWithLog("user@example.com", (m) => logs.push(m));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/Font profile:.*(minimal|typical-user|heavy-user).*\(\d+ fonts\)/);
  });

  it("each profile name maps to a non-empty canonical font list", () => {
    for (const name of listFontProfileNames()) {
      const fonts = getFontsByName(name);
      expect(fonts.length).toBeGreaterThan(0);
      expect(fonts).toContain("Arial");
    }
  });

  it("heavy-user profile has the largest font list", () => {
    const minimal = getFontsByName("minimal");
    const typical = getFontsByName("typical-user");
    const heavy = getFontsByName("heavy-user");
    expect(heavy.length).toBeGreaterThan(typical.length);
    expect(typical.length).toBeGreaterThanOrEqual(minimal.length);
  });

  it("distributes emails across all three profiles over many samples", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(getFontProfile(`u${i}@x.com`).name);
    expect(seen.size).toBe(3);
  });
});

