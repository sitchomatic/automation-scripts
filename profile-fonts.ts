/**
 * Font List Consistency
 * Maps credential email to a realistic font set (minimal / typical / heavy).
 * Same email always returns the same set — eliminates "impossible font combo"
 * detections caused by random per-session font enumeration.
 *
 * NOTE: cloakbrowser owns native font enumeration via its C++ patches. The
 * profile here is exposed on SessionHandle for observability and downstream
 * decisions (e.g. fingerprint-test asserting consistency); we do NOT inject
 * a JS-level override (would layer detectable emulation on top of native).
 */

import * as crypto from "crypto";

export type FontProfileName = "minimal" | "typical-user" | "heavy-user";

export interface FontProfile {
  name: FontProfileName;
  fonts: string[];
}

const FONT_PROFILES: Record<FontProfileName, string[]> = {
  "minimal": [
    "Arial", "Courier New", "Georgia", "Times New Roman", "Verdana",
  ],
  "typical-user": [
    "Arial", "Courier New", "Georgia", "Segoe UI", "Tahoma",
    "Times New Roman", "Trebuchet MS", "Verdana",
  ],
  "heavy-user": [
    "Arial", "Calibri", "Cambria", "Candara", "Comic Sans MS",
    "Consolas", "Constantia", "Corbel", "Courier New", "Garamond",
    "Georgia", "Impact", "Lucida Console", "Lucida Sans Unicode",
    "Palatino Linotype", "Segoe Print", "Segoe Script", "Segoe UI",
    "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana",
  ],
};

const PROFILE_NAMES: FontProfileName[] = ["minimal", "typical-user", "heavy-user"];

function hashEmail(email: string): number {
  const normalized = email.trim().toLowerCase();
  const digest = crypto.createHash("sha256").update(normalized).digest();
  return digest.readUInt32BE(0);
}

/**
 * Get the deterministic font profile for an email.
 * Same email → same profile every call.
 */
export function getFontProfile(email: string): FontProfile {
  const idx = hashEmail(email) % PROFILE_NAMES.length;
  const name = PROFILE_NAMES[idx];
  return { name, fonts: [...FONT_PROFILES[name]] };
}

/**
 * Logged variant — returns the profile and emits a one-line summary.
 */
export function getFontProfileWithLog(
  email: string,
  logFn?: (msg: string) => void
): FontProfile {
  const fp = getFontProfile(email);
  const msg = `Font profile: ${email} → ${fp.name} (${fp.fonts.length} fonts)`;
  if (logFn) logFn(msg);
  return fp;
}

/** All known profile names. Useful for tests. */
export function listFontProfileNames(): readonly FontProfileName[] {
  return PROFILE_NAMES;
}

/** Look up the canonical font list for a named profile. */
export function getFontsByName(name: FontProfileName): readonly string[] {
  return FONT_PROFILES[name];
}

