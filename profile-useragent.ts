/**
 * User Agent Freshness
 * Maps credential email to a contemporary Chrome/Windows UA profile.
 * Same email always returns the same UA — keeps fingerprint stable.
 *
 * Pool curated for early-to-mid 2026 — Chrome stable releases on the
 * 4-week cadence plus the two most-deployed Windows builds (Win10 22H2
 * 19045 and Win11 23H2 22631).
 */

import * as crypto from "crypto";

export interface UAProfile {
  ua: string;
  chromeVersion: string;     // full version e.g. "136.0.7103.92"
  chromeMajor: number;       // major e.g. 136
  windowsVersion: string;    // build string e.g. "10.0.22631"
  windowsLabel: "Win10" | "Win11";
}

/**
 * Static pool of plausibly current Chrome × Windows UAs.
 * Refresh quarterly; CloakBrowser's native UA gen is unaffected — these
 * values feed --fingerprint-platform-version so the BINARY emits a matching
 * UA without JS-layer overrides (which CDP-emulation detectors flag).
 */
const UA_POOL: UAProfile[] = [
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6943.142 Safari/537.36",
    chromeVersion: "133.0.6943.142", chromeMajor: 133,
    windowsVersion: "10.0.19045", windowsLabel: "Win10",
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.118 Safari/537.36",
    chromeVersion: "134.0.6998.118", chromeMajor: 134,
    windowsVersion: "10.0.22631", windowsLabel: "Win11",
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.7049.96 Safari/537.36",
    chromeVersion: "135.0.7049.96", chromeMajor: 135,
    windowsVersion: "10.0.22631", windowsLabel: "Win11",
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.92 Safari/537.36",
    chromeVersion: "136.0.7103.92", chromeMajor: 136,
    windowsVersion: "10.0.19045", windowsLabel: "Win10",
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.7158.55 Safari/537.36",
    chromeVersion: "137.0.7158.55", chromeMajor: 137,
    windowsVersion: "10.0.22631", windowsLabel: "Win11",
  },
];

function hashEmail(email: string): number {
  const normalized = email.trim().toLowerCase();
  const digest = crypto.createHash("sha256").update(normalized).digest();
  return digest.readUInt32BE(0);
}

/**
 * Get the deterministic UA profile for an email.
 * Same email → same profile every call.
 */
export function getConsistentUserAgent(email: string): UAProfile {
  const idx = hashEmail(email) % UA_POOL.length;
  return { ...UA_POOL[idx] };
}

/**
 * Logged variant — returns the profile and emits a one-line summary.
 */
export function getConsistentUserAgentWithLog(
  email: string,
  logFn?: (msg: string) => void
): UAProfile {
  const ua = getConsistentUserAgent(email);
  const msg = `UA freshness: ${email} → Chrome ${ua.chromeMajor} on ${ua.windowsLabel} (${ua.windowsVersion})`;
  if (logFn) logFn(msg);
  return ua;
}

/**
 * Convert a UA profile into CloakBrowser CLI args.
 * Routes through binary flags — does NOT set Playwright's userAgent override
 * (which would layer JS emulation on top of cloakbrowser's native patches).
 */
export function getUserAgentArgs(profile: UAProfile): string[] {
  return [
    `--fingerprint-platform-version=${profile.windowsVersion}`,
    `--fingerprint-browser-version=${profile.chromeVersion}`,
  ];
}

/** Number of UAs in the pool. Useful for tests / metrics. */
export function getUserAgentPoolSize(): number {
  return UA_POOL.length;
}

/** Return read-only view of all UAs (for diagnostics, test coverage). */
export function listUserAgentPool(): readonly UAProfile[] {
  return UA_POOL;
}

