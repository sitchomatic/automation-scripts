/**
 * Browser Extension Simulation
 * Per-credential pick of plausible Chrome extensions. Same email → same set.
 *
 * Real users typically have 2–5 extensions installed. A profile with NONE
 * is a soft anti-bot signal. We can't actually install Chrome extensions
 * inside cloakbrowser without disrupting its native patches, so we instead
 * emit subtle DOM-level hints that several common extensions have hooked.
 *
 * NOTE: This is an ADDITIVE injection (defines new properties on
 * window/navigator/chrome) — it does NOT override existing values, which
 * keeps it compatible with cloakbrowser's C++ patches.
 */

import * as crypto from "crypto";

export interface ExtensionInfo {
  id: string;          // synthetic but plausible
  name: string;        // e.g. "uBlock Origin"
  /** Property/marker the extension is known to leak into the page. */
  domHint: string;
}

const EXTENSION_POOL: ExtensionInfo[] = [
  {
    id: "cjpalhdlnbpafiamejdnhcphjbkeiagm", name: "uBlock Origin",
    domHint: "ublock_origin_loaded"
  },
  {
    id: "kbfnbcaeplbcioakkpcpgfkobkghlhen", name: "Grammarly",
    domHint: "grammarly_extension_present"
  },
  {
    id: "hdokiejnpimakedhajhdlcegeplioahd", name: "LastPass",
    domHint: "lpgst"
  },
  {
    id: "bmnlcjabgnpnenekpadlanbbkooimhnj", name: "Honey",
    domHint: "honey_loaded"
  },
  {
    id: "gighmmpiobklfepjocnamgkkbiglidom", name: "AdBlock",
    domHint: "ab_present"
  },
  {
    id: "bfbmjmiodbnnpllbbbfblcplfjjepjdn", name: "1Password",
    domHint: "op_extension_marker"
  },
  {
    id: "fhbjgbiflinjbdggehcddcbncdddomop", name: "Postman Interceptor",
    domHint: "postman_interceptor"
  },
  {
    id: "nkbihfbeogaeaoehlefnkodbefgpgknn", name: "MetaMask",
    domHint: "ethereum_provider"
  },
];

function hashEmail(email: string): number {
  const normalized = email.trim().toLowerCase();
  const digest = crypto.createHash("sha256").update(normalized).digest();
  return digest.readUInt32BE(0);
}

export interface ExtensionProfile {
  email: string;
  extensions: ExtensionInfo[];
}

/**
 * Pick 2–4 deterministic extensions for an email.
 * Same email → same set every call.
 */
export function getExtensionProfile(email: string): ExtensionProfile {
  const normalized = email.trim().toLowerCase();
  const seed = hashEmail(normalized);
  const count = 2 + (seed % 3); // 2, 3, or 4
  const used = new Set<number>();
  const picks: ExtensionInfo[] = [];
  let cursor = seed;
  while (picks.length < count) {
    cursor = (Math.imul(cursor, 1103515245) + 12345) >>> 0; // LCG
    const idx = cursor % EXTENSION_POOL.length;
    if (used.has(idx)) continue;
    used.add(idx);
    picks.push({ ...EXTENSION_POOL[idx] });
  }
  return { email: normalized, extensions: picks };
}

/**
 * Logged variant — returns the profile and emits a one-line summary.
 */
export function getExtensionProfileWithLog(
  email: string,
  logFn?: (msg: string) => void
): ExtensionProfile {
  const p = getExtensionProfile(email);
  const names = p.extensions.map((e) => e.name).join(", ");
  if (logFn) logFn(`Extensions: ${email} → ${p.extensions.length} installed (${names})`);
  return p;
}

/**
 * Build the addInitScript body that signals these extensions are present.
 * Uses defineProperty with `configurable: true` and only sets keys that
 * don't already exist — never overwrites native getters.
 */
export function getExtensionInjectionScript(profile: ExtensionProfile): string {
  const hints = profile.extensions.map((e) => e.domHint);
  const ids = profile.extensions.map((e) => e.id);
  return `
(function() {
  try {
    var hints = ${JSON.stringify(hints)};
    for (var i = 0; i < hints.length; i++) {
      var key = hints[i];
      if (!(key in window)) {
        try { Object.defineProperty(window, key, { value: true, configurable: true, writable: false, enumerable: false }); } catch (e) {}
      }
    }
    if (typeof window.chrome === 'object' && window.chrome) {
      if (!window.chrome.runtime) {
        try { Object.defineProperty(window.chrome, 'runtime', { value: { id: undefined, OnInstalledReason: { INSTALL: 'install', UPDATE: 'update' }, OnRestartRequiredReason: { APP_UPDATE: 'app_update' } }, configurable: true }); } catch (e) {}
      }
    }
    var ids = ${JSON.stringify(ids)};
    if (!('__installed_extension_ids' in window)) {
      try { Object.defineProperty(window, '__installed_extension_ids', { value: Object.freeze(ids.slice()), configurable: true, enumerable: false }); } catch (e) {}
    }
  } catch (e) {}
})();
  `;
}

/** Read-only view of the pool (for tests / diagnostics). */
export function listExtensionPool(): readonly ExtensionInfo[] {
  return EXTENSION_POOL;
}

/** Pool size — useful for distribution tests. */
export function getExtensionPoolSize(): number {
  return EXTENSION_POOL.length;
}

