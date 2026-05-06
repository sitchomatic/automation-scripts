import { describe, it, expect } from "vitest";
import {
  getInteractionPattern,
  getInteractionPatternWithLog,
  getActionDelayMs,
  getKeystrokeDelayMs,
  getHoverDwellMs,
  getCursorJitter,
  getInteractionPatternPoolSize,
  listInteractionPatterns,
} from "./profile-interaction.js";

describe("profile-interaction", () => {
  it("returns the same pattern for the same email", () => {
    const a = getInteractionPattern("user@example.com");
    const b = getInteractionPattern("user@example.com");
    expect(a).toEqual(b);
  });

  it("is case-insensitive and trims whitespace", () => {
    const a = getInteractionPattern("USER@Example.com");
    const b = getInteractionPattern("  user@example.com  ");
    expect(a).toEqual(b);
  });

  it("returns one of the known persona names", () => {
    const p = getInteractionPattern("alice@example.com");
    expect(["deliberate-typer", "average-user", "power-user"]).toContain(p.name);
  });

  it("each pattern has plausible numeric ranges", () => {
    for (const p of listInteractionPatterns()) {
      expect(p.pauseFrequency).toBeGreaterThan(50);
      expect(p.pauseFrequency).toBeLessThan(1000);
      expect(p.keystrokeDelayMs).toBeGreaterThanOrEqual(20);
      expect(p.keystrokeDelayMs).toBeLessThan(300);
      expect(p.hoverDwellMs).toBeGreaterThanOrEqual(20);
      expect(p.jitterAmount).toBeGreaterThanOrEqual(0);
    }
  });

  it("logs a summary when logFn is provided", () => {
    const logs: string[] = [];
    getInteractionPatternWithLog("user@example.com", (m) => logs.push(m));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/Interaction:.*\b(deliberate-typer|average-user|power-user)\b.*kbd=\d+ms/);
  });

  it("getActionDelayMs returns a positive integer near pauseFrequency", () => {
    const p = getInteractionPattern("alice@example.com");
    for (let i = 0; i < 50; i++) {
      const d = getActionDelayMs(p);
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThan(p.pauseFrequency * 2);
    }
  });

  it("getKeystrokeDelayMs returns a positive integer near base", () => {
    const p = getInteractionPattern("alice@example.com");
    for (let i = 0; i < 50; i++) {
      const d = getKeystrokeDelayMs(p);
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(10);
      expect(d).toBeLessThan(p.keystrokeDelayMs * 2);
    }
  });

  it("getHoverDwellMs respects floor", () => {
    const p = getInteractionPattern("bob@example.com");
    for (let i = 0; i < 30; i++) {
      expect(getHoverDwellMs(p)).toBeGreaterThanOrEqual(20);
    }
  });

  it("getCursorJitter stays inside ±jitterAmount and is zero when amount=0", () => {
    const p = getInteractionPattern("alice@example.com");
    for (let i = 0; i < 50; i++) {
      const { dx, dy } = getCursorJitter(p);
      expect(Math.abs(dx)).toBeLessThanOrEqual(p.jitterAmount);
      expect(Math.abs(dy)).toBeLessThanOrEqual(p.jitterAmount);
    }
    const zero = getCursorJitter({ ...p, jitterAmount: 0 });
    expect(zero).toEqual({ dx: 0, dy: 0 });
  });

  it("distributes emails across all patterns over many samples", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(getInteractionPattern(`u${i}@x.com`).name);
    expect(seen.size).toBe(getInteractionPatternPoolSize());
  });
});

