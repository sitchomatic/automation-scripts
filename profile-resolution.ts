/**
 * Screen Resolution Alignment
 * Maps credential email to a realistic viewport drawn from the StatCounter
 * desktop resolution distribution. Same email always returns the same
 * resolution — keeps fingerprint stable across sessions while making the
 * batch as a whole look heterogeneous.
 */

import * as crypto from "crypto";

export interface Resolution {
  width: number;
  height: number;
  /** Approximate desktop share (%) from public market reports. */
  share: number;
  /** Human label for logging. */
  label: string;
}

/**
 * Realistic desktop resolutions weighted by global market share (rounded).
 * The hash distribution is uniform; share is exposed for diagnostics only.
 */
const RESOLUTION_POOL: Resolution[] = [
  { width: 1920, height: 1080, share: 23, label: "FHD" },
  { width: 1366, height: 768, share: 18, label: "HD-laptop" },
  { width: 1536, height: 864, share: 11, label: "FHD-scaled-125" },
  { width: 2560, height: 1440, share: 12, label: "QHD" },
  { width: 1440, height: 900, share: 8, label: "MBP-13" },
  { width: 1600, height: 900, share: 6, label: "HD+" },
  { width: 1680, height: 1050, share: 4, label: "WSXGA+" },
  { width: 3840, height: 2160, share: 3, label: "4K-UHD" },
];

/**
 * Compact pool used for headed/debug runs so multiple windows fit on a
 * developer screen without overlapping. Still plausible (low-end laptops,
 * small browser windows) so fingerprints don't look obviously synthetic.
 */
const SMALL_RESOLUTION_POOL: Resolution[] = [
  { width: 1024, height: 600, share: 0, label: "WSVGA-netbook" },
  { width: 1024, height: 768, share: 0, label: "XGA" },
  { width: 1152, height: 720, share: 0, label: "compact-16:10" },
  { width: 1200, height: 720, share: 0, label: "compact-5:3" },
  { width: 1280, height: 720, share: 0, label: "HD-window" },
  { width: 1280, height: 800, share: 0, label: "WXGA" },
];

function hashEmail(email: string): number {
  const normalized = email.trim().toLowerCase();
  const digest = crypto.createHash("sha256").update(normalized).digest();
  return digest.readUInt32BE(0);
}

/**
 * Get the deterministic resolution for an email.
 * Same email → same resolution every call.
 */
export function getConsistentResolution(email: string): Resolution {
  const idx = hashEmail(email) % RESOLUTION_POOL.length;
  return { ...RESOLUTION_POOL[idx] };
}

/**
 * Logged variant — returns the resolution and emits a one-line summary.
 */
export function getConsistentResolutionWithLog(
  email: string,
  logFn?: (msg: string) => void
): Resolution {
  const r = getConsistentResolution(email);
  const msg = `Resolution: ${email} → ${r.width}x${r.height} (${r.label}, ~${r.share}% share)`;
  if (logFn) logFn(msg);
  return r;
}

/** Convert a Resolution into a Playwright/cloakbrowser viewport object. */
export function getViewport(resolution: Resolution): { width: number; height: number } {
  return { width: resolution.width, height: resolution.height };
}

/** Number of resolutions in the pool. */
export function getResolutionPoolSize(): number {
  return RESOLUTION_POOL.length;
}

/** Read-only view of the pool. */
export function listResolutionPool(): readonly Resolution[] {
  return RESOLUTION_POOL;
}

/**
 * Deterministic small viewport for headed/debug runs.
 * Same email → same compact resolution every call.
 */
export function getConsistentSmallResolution(email: string): Resolution {
  const idx = hashEmail(email) % SMALL_RESOLUTION_POOL.length;
  return { ...SMALL_RESOLUTION_POOL[idx] };
}

/** Read-only view of the small pool. */
export function listSmallResolutionPool(): readonly Resolution[] {
  return SMALL_RESOLUTION_POOL;
}

