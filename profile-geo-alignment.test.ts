/**
 * Tests for Timezone + Locale Alignment
 */

import { describe, it, expect } from "vitest";
import {
  alignGeoToProxy,
  alignGeoToProxyWithLog,
  getGeoLaunchArgs,
  validateGeoProfile,
} from "./profile-geo-alignment.js";

describe("profile-geo-alignment", () => {
  it("returns US profile for empty proxy", () => {
    const geo = alignGeoToProxy();
    expect(geo.countryCode).toBe("US");
    expect(geo.timezone).toBe("America/New_York");
    expect(geo.locale).toBe("en-US");
  });

  it("returns US profile for empty string", () => {
    const geo = alignGeoToProxy("");
    expect(geo.countryCode).toBe("US");
  });

  it("detects AU proxy", () => {
    const geo = alignGeoToProxy("http://user:pass@au.proxy.com:8080");
    expect(geo.countryCode).toBe("AU");
    expect(geo.timezone).toBe("Australia/Melbourne");
    expect(geo.locale).toBe("en-AU");
  });

  it("detects GB proxy", () => {
    const geo = alignGeoToProxy("http://user:pass@uk.proxy.com:8080");
    expect(geo.countryCode).toBe("GB");
    expect(geo.timezone).toBe("Europe/London");
  });

  it("detects DE proxy", () => {
    const geo = alignGeoToProxy("http://user:pass@de.proxy.com:8080");
    expect(geo.countryCode).toBe("DE");
    expect(geo.timezone).toBe("Europe/Berlin");
  });

  it("detects JP proxy", () => {
    const geo = alignGeoToProxy("http://user:pass@jp.proxy.com:8080");
    expect(geo.countryCode).toBe("JP");
    expect(geo.timezone).toBe("Asia/Tokyo");
  });

  it("falls back to US for unknown proxy patterns", () => {
    const geo = alignGeoToProxy("http://user:pass@random-host.example.com:8080");
    expect(geo.countryCode).toBe("US");
  });

  it("returns same geo for identical proxy URL", () => {
    const proxy = "http://user:pass@au.proxy.com:8080";
    expect(alignGeoToProxy(proxy)).toEqual(alignGeoToProxy(proxy));
  });

  it("detects country from co.uk pattern", () => {
    const geo = alignGeoToProxy("http://user:pass@server.co.uk:8080");
    expect(geo.countryCode).toBe("GB");
  });

  it("logs geo alignment when logFn provided", () => {
    const logs: string[] = [];
    alignGeoToProxyWithLog("http://user:pass@au.proxy.com:8080", (msg) => logs.push(msg));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Geo alignment");
    expect(logs[0]).toContain("AU");
  });

  it("logs 'direct' for empty proxy", () => {
    const logs: string[] = [];
    alignGeoToProxyWithLog(undefined, (msg) => logs.push(msg));
    expect(logs[0]).toContain("direct");
  });

  it("extracts launch args correctly", () => {
    const geo = alignGeoToProxy("http://user:pass@au.proxy.com:8080");
    const args = getGeoLaunchArgs(geo);
    expect(args.timezone).toBe("Australia/Melbourne");
    expect(args.locale).toBe("en-AU");
  });

  it("validates valid geo profile", () => {
    const geo = alignGeoToProxy("http://user:pass@au.proxy.com:8080");
    expect(validateGeoProfile(geo)).toBe(true);
  });

  it("rejects invalid timezone", () => {
    expect(
      validateGeoProfile({ timezone: "not-a-timezone", locale: "en-US", countryCode: "US" })
    ).toBe(false);
  });

  it("rejects invalid locale", () => {
    expect(
      validateGeoProfile({ timezone: "America/New_York", locale: "NOT-A-LOCALE", countryCode: "US" })
    ).toBe(false);
  });
});

