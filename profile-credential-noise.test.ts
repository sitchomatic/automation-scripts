/**
 * Tests for Canvas/WebGL Noise Per-Credential
 */

import { describe, it, expect } from "vitest";
import {
  deriveNoiseSeedFromEmail,
  getCanvasNoiseParams,
  getWebGLNoiseParams,
  getAudioNoiseParams,
  buildCredentialNoiseProfile,
  getCanvasNoiseInjectionScript,
  getWebGLNoiseInjectionScript,
} from "./profile-credential-noise.js";

describe("profile-credential-noise", () => {
  it("derives consistent seed from same email", () => {
    expect(deriveNoiseSeedFromEmail("test@example.com"))
      .toBe(deriveNoiseSeedFromEmail("test@example.com"));
  });

  it("derives different seed for different emails", () => {
    expect(deriveNoiseSeedFromEmail("user1@example.com"))
      .not.toBe(deriveNoiseSeedFromEmail("user2@example.com"));
  });

  it("is case-insensitive", () => {
    expect(deriveNoiseSeedFromEmail("Test@Example.COM"))
      .toBe(deriveNoiseSeedFromEmail("test@example.com"));
  });

  it("ignores whitespace", () => {
    expect(deriveNoiseSeedFromEmail("  test@example.com  "))
      .toBe(deriveNoiseSeedFromEmail("test@example.com"));
  });

  it("returns positive integer seed", () => {
    const seed = deriveNoiseSeedFromEmail("test@example.com");
    expect(seed).toBeGreaterThan(0);
    expect(Number.isInteger(seed)).toBe(true);
  });

  it("generates consistent canvas noise params", () => {
    expect(getCanvasNoiseParams("test@example.com"))
      .toEqual(getCanvasNoiseParams("test@example.com"));
  });

  it("canvas pixelNoise is in valid range", () => {
    const params = getCanvasNoiseParams("test@example.com");
    expect(params.pixelNoise).toBeGreaterThan(0);
    expect(params.pixelNoise).toBeLessThanOrEqual(0.1);
  });

  it("canvas offsets are valid pixel coordinates", () => {
    const params = getCanvasNoiseParams("test@example.com");
    expect(params.offsetX).toBeGreaterThanOrEqual(0);
    expect(params.offsetX).toBeLessThan(256);
    expect(params.offsetY).toBeGreaterThanOrEqual(0);
    expect(params.offsetY).toBeLessThan(256);
  });

  it("generates consistent WebGL noise params", () => {
    expect(getWebGLNoiseParams("test@example.com"))
      .toEqual(getWebGLNoiseParams("test@example.com"));
  });

  it("WebGL variance is in valid range", () => {
    const params = getWebGLNoiseParams("test@example.com");
    expect(params.variance).toBeGreaterThan(0);
    expect(params.variance).toBeLessThanOrEqual(1);
  });

  it("WebGL colorShift is valid hue 0-360", () => {
    const params = getWebGLNoiseParams("test@example.com");
    expect(params.colorShift).toBeGreaterThanOrEqual(0);
    expect(params.colorShift).toBeLessThan(360);
  });

  it("generates consistent audio noise params", () => {
    expect(getAudioNoiseParams("test@example.com"))
      .toEqual(getAudioNoiseParams("test@example.com"));
  });

  it("audio frequencyShift is in expected range", () => {
    const params = getAudioNoiseParams("test@example.com");
    expect(Math.abs(params.frequencyShift)).toBeLessThanOrEqual(0.05);
  });

  it("builds full credential noise profile", () => {
    const profile = buildCredentialNoiseProfile("test@example.com");
    expect(profile.email).toBe("test@example.com");
    expect(profile.noiseSeed).toBeGreaterThan(0);
    expect(profile.canvas).toBeDefined();
    expect(profile.webgl).toBeDefined();
    expect(profile.audio).toBeDefined();
  });

  it("two profiles for same email are identical", () => {
    expect(buildCredentialNoiseProfile("test@example.com"))
      .toEqual(buildCredentialNoiseProfile("test@example.com"));
  });

  it("generates valid canvas injection script", () => {
    const profile = buildCredentialNoiseProfile("test@example.com");
    const script = getCanvasNoiseInjectionScript(profile);
    expect(script).toContain("toDataURL");
    expect(script).toContain("HTMLCanvasElement");
    expect(script).toContain(profile.noiseSeed.toString());
  });

  it("generates valid WebGL injection script", () => {
    const profile = buildCredentialNoiseProfile("test@example.com");
    const script = getWebGLNoiseInjectionScript(profile);
    expect(script).toContain("WebGLRenderingContext");
    expect(script).toContain("getParameter");
  });

  it("distributes seeds across many emails", () => {
    const emails = Array.from({ length: 100 }, (_, i) => `user${i}@domain.com`);
    const seeds = emails.map(deriveNoiseSeedFromEmail);
    const unique = new Set(seeds);
    expect(unique.size).toBe(100);
  });
});

