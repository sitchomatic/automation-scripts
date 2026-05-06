/**
 * Tests for Hardware Profile Determinism
 */

import { describe, it, expect } from "vitest";
import {
  getConsistentHardware,
  getConsistentHardwareWithLog,
  getHardwareArgs,
  getNavigatorOverrides,
  type HardwareProfile,
} from "./profile-determinism.js";

describe("profile-determinism", () => {
  it("returns consistent hardware for same email", () => {
    const hw1 = getConsistentHardware("test@example.com");
    const hw2 = getConsistentHardware("test@example.com");
    expect(hw1).toEqual(hw2);
  });

  it("returns different hardware for different email domains", () => {
    const hw1 = getConsistentHardware("user@gmail.com");
    const hw2 = getConsistentHardware("user@yahoo.com");
    expect(hw1).not.toEqual(hw2);
  });

  it("is case-insensitive", () => {
    const hw1 = getConsistentHardware("Test@Example.COM");
    const hw2 = getConsistentHardware("test@example.com");
    expect(hw1).toEqual(hw2);
  });

  it("ignores whitespace", () => {
    const hw1 = getConsistentHardware("  test@example.com  ");
    const hw2 = getConsistentHardware("test@example.com");
    expect(hw1).toEqual(hw2);
  });

  it("returns valid hardware profile structure", () => {
    const hw = getConsistentHardware("test@example.com");
    expect(hw).toHaveProperty("cores");
    expect(hw).toHaveProperty("memory");
    expect(hw).toHaveProperty("gpu");
    expect(hw.gpu).toHaveProperty("vendor");
    expect(hw.gpu).toHaveProperty("renderer");
  });

  it("returns valid cores and memory values", () => {
    const hw = getConsistentHardware("test@example.com");
    expect(hw.cores).toBeGreaterThanOrEqual(4);
    expect(hw.cores).toBeLessThanOrEqual(16);
    expect(hw.memory).toBeGreaterThanOrEqual(8);
    expect(hw.memory).toBeLessThanOrEqual(32);
  });

  it("logs hardware profile when logFn provided", () => {
    const logs: string[] = [];
    getConsistentHardwareWithLog("test@example.com", (msg) => logs.push(msg));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Hardware determinism");
  });

  it("generates valid hardware args", () => {
    const hw = getConsistentHardware("test@example.com");
    const args = getHardwareArgs(hw);
    expect(args).toBeInstanceOf(Array);
    expect(args.length).toBeGreaterThan(0);
    expect(args[0]).toMatch(/^--use-angle/);
  });

  it("generates correct args for NVIDIA hardware", () => {
    const hw: HardwareProfile = {
      cores: 8,
      memory: 16,
      gpu: { vendor: "NVIDIA", renderer: "GeForce GTX 1650" },
    };
    expect(getHardwareArgs(hw)[0]).toBe("--use-angle=opengl");
  });

  it("generates correct args for AMD hardware", () => {
    const hw: HardwareProfile = {
      cores: 12,
      memory: 32,
      gpu: { vendor: "AMD", renderer: "Radeon RX 6600" },
    };
    expect(getHardwareArgs(hw)[0]).toBe("--use-angle=vulkan");
  });

  it("generates correct args for Intel hardware", () => {
    const hw: HardwareProfile = {
      cores: 4,
      memory: 8,
      gpu: { vendor: "Intel", renderer: "UHD Graphics 630" },
    };
    expect(getHardwareArgs(hw)[0]).toBe("--use-angle=d3d11");
  });

  it("generates navigator overrides with correct values", () => {
    const hw = getConsistentHardware("test@example.com");
    const nav = getNavigatorOverrides(hw);
    expect(nav.hardwareConcurrency).toBe(hw.cores);
    expect(nav.deviceMemory).toBe(hw.memory);
  });

  it("distributes emails across multiple presets", () => {
    const emails = Array.from({ length: 100 }, (_, i) => `user${i}@domain${i}.com`);
    const profiles = emails.map((e) => getConsistentHardware(e));
    const unique = new Set(profiles.map((p) => JSON.stringify(p)));
    expect(unique.size).toBeGreaterThan(4);
  });
});

