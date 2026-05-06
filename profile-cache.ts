/**
 * Service Worker / Cache Authenticity
 * Pre-populates per-credential localStorage hints so the profile doesn't
 * look freshly-minted. Same email → same "history".
 *
 * Real browsers carry crumbs from prior visits: a `last_visit` timestamp,
 * a cached client_id, a settled timezone string. A profile with an empty
 * localStorage on every site is one of the cheapest "new bot" signals
 * for fingerprint vendors to query.
 *
 * NOTE: ADDITIVE only — we never overwrite keys that the site itself sets.
 * The injection runs at the document_start phase via context.addInitScript.
 */

import * as crypto from "crypto";

export interface CacheProfile {
  email: string;
  /** Days ago (1-30) the user last "visited". */
  lastVisitDaysAgo: number;
  /** Synthetic stable client id (UUID-shaped). */
  clientId: string;
  /** UA Chrome major used for the breadcrumb. */
  chromeMajor: number;
  /** Whether to advertise a populated cache via Cache API. */
  serviceWorkerHint: boolean;
}

function hashEmail(email: string): Buffer {
  const normalized = email.trim().toLowerCase();
  return crypto.createHash("sha256").update(normalized).digest();
}

function uuidFromHash(hash: Buffer): string {
  const hex = hash.toString("hex");
  // RFC4122-shaped (variant bits not strictly enforced — this is a synthetic id).
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Get the deterministic cache profile for an email.
 * Same email → same profile every call.
 */
export function getCacheProfile(email: string, chromeMajor = 136): CacheProfile {
  const normalized = email.trim().toLowerCase();
  const hash = hashEmail(normalized);
  const u32 = hash.readUInt32BE(0);
  return {
    email: normalized,
    lastVisitDaysAgo: 1 + (u32 % 30),
    clientId: uuidFromHash(hash),
    chromeMajor,
    serviceWorkerHint: (u32 % 2) === 0,
  };
}

/**
 * Logged variant — returns the profile and emits a one-line summary.
 */
export function getCacheProfileWithLog(
  email: string,
  chromeMajor?: number,
  logFn?: (msg: string) => void
): CacheProfile {
  const p = getCacheProfile(email, chromeMajor);
  if (logFn) logFn(`Cache: ${email} → last_visit ${p.lastVisitDaysAgo}d ago, client_id=${p.clientId.slice(0, 8)}…, sw=${p.serviceWorkerHint}`);
  return p;
}

/**
 * Build the addInitScript body that seeds localStorage with breadcrumbs.
 * Only writes keys that aren't already set — never clobbers site state.
 */
export function getCacheInjectionScript(profile: CacheProfile): string {
  const visitMs = Date.now() - profile.lastVisitDaysAgo * 86400000;
  return `
(function() {
  try {
    if (typeof localStorage === 'undefined') return;
    function setIfAbsent(k, v) {
      try { if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } catch (e) {}
    }
    setIfAbsent('last_visit', ${JSON.stringify(new Date(visitMs).toISOString())});
    setIfAbsent('browser_version', 'Chrome/${profile.chromeMajor}');
    setIfAbsent('client_id', ${JSON.stringify(profile.clientId)});
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) setIfAbsent('user_timezone', tz);
    } catch (e) {}
    ${profile.serviceWorkerHint ? `
    try {
      if ('caches' in window && typeof caches.open === 'function') {
        caches.open('v1').catch(function(){});
      }
    } catch (e) {}` : ""}
  } catch (e) {}
})();
  `;
}

