import { describe, it, expect } from "vitest";
import {
  getExtensionProfile,
  getExtensionProfileWithLog,
  getExtensionInjectionScript,
  getExtensionPoolSize,
  listExtensionPool,
} from "./profile-extensions.js";

describe("profile-extensions", () => {
  it("returns the same profile for the same email", () => {
    const a = getExtensionProfile("user@example.com");
    const b = getExtensionProfile("user@example.com");
    expect(a).toEqual(b);
  });

  it("is case-insensitive and trims whitespace", () => {
    const a = getExtensionProfile("USER@Example.com");
    const b = getExtensionProfile("  user@example.com  ");
    expect(a).toEqual(b);
  });

  it("picks 2-4 distinct extensions per credential", () => {
    for (let i = 0; i < 30; i++) {
      const p = getExtensionProfile(`u${i}@x.com`);
      expect(p.extensions.length).toBeGreaterThanOrEqual(2);
      expect(p.extensions.length).toBeLessThanOrEqual(4);
      const ids = p.extensions.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length); // no duplicates
    }
  });

  it("each extension has a plausible 32-char id and non-empty name/hint", () => {
    const p = getExtensionProfile("alice@example.com");
    for (const e of p.extensions) {
      expect(e.id).toMatch(/^[a-z]{32}$/);
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.domHint.length).toBeGreaterThan(0);
    }
  });

  it("logs a summary when logFn is provided", () => {
    const logs: string[] = [];
    getExtensionProfileWithLog("user@example.com", (m) => logs.push(m));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/Extensions:.*\d+ installed \(/);
  });

  it("injection script references all picked hints and is syntactically wrapped", () => {
    const p = getExtensionProfile("alice@example.com");
    const script = getExtensionInjectionScript(p);
    expect(script).toContain("(function()");
    expect(script).toContain("})();");
    for (const e of p.extensions) {
      expect(script).toContain(JSON.stringify(e.domHint));
      expect(script).toContain(JSON.stringify(e.id));
    }
  });

  it("injection script never overwrites existing window keys (uses defineProperty + in-check)", () => {
    const p = getExtensionProfile("alice@example.com");
    const script = getExtensionInjectionScript(p);
    expect(script).toContain("if (!(key in window))");
    expect(script).toContain("Object.defineProperty");
  });

  it("pool has at least 6 plausible extensions", () => {
    expect(getExtensionPoolSize()).toBeGreaterThanOrEqual(6);
  });

  it("distributes picks across most of the pool over many samples", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      for (const e of getExtensionProfile(`u${i}@x.com`).extensions) seen.add(e.id);
    }
    expect(seen.size).toBeGreaterThanOrEqual(Math.floor(getExtensionPoolSize() * 0.75));
  });

  it("every pool entry has a distinct id and hint", () => {
    const pool = listExtensionPool();
    expect(new Set(pool.map((e) => e.id)).size).toBe(pool.length);
    expect(new Set(pool.map((e) => e.domHint)).size).toBe(pool.length);
  });
});

