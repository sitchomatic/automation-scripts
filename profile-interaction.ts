/**
 * Page Interaction Patterns
 * Per-credential mouse/typing behaviour profile. Same email → same persona.
 *
 * Goal: defeat behaviour-cluster detection that flags swarms of accounts
 * sharing identical click cadence and typing speed. cloakbrowser's `humanize`
 * gives us realistic mouse curves; this layer adds per-persona timing
 * variance on top (delays between actions, per-keystroke pacing, hover
 * dwell time, scroll jitter).
 */

import * as crypto from "crypto";

export type MouseSpeed = "slow" | "normal" | "fast";
export type TypingSpeed = "hunt-peck" | "normal" | "fluent";

export interface InteractionPattern {
  name: string;                 // human label, e.g. "deliberate-typer"
  mouseSpeed: MouseSpeed;
  typingSpeed: TypingSpeed;
  /** Base ms between successive UI actions (jittered ±50% at call time). */
  pauseFrequency: number;
  /** Pixel deviation injected into mouse hover targets. */
  jitterAmount: number;
  /** Mean ms between keystrokes (Playwright `delay` param). */
  keystrokeDelayMs: number;
  /** ms to dwell on hover before clicking. */
  hoverDwellMs: number;
}

const PATTERNS: InteractionPattern[] = [
  {
    name: "deliberate-typer",
    mouseSpeed: "slow", typingSpeed: "hunt-peck",
    pauseFrequency: 320, jitterAmount: 6,
    keystrokeDelayMs: 140, hoverDwellMs: 280,
  },
  {
    name: "average-user",
    mouseSpeed: "normal", typingSpeed: "normal",
    pauseFrequency: 160, jitterAmount: 3,
    keystrokeDelayMs: 70, hoverDwellMs: 140,
  },
  {
    name: "power-user",
    mouseSpeed: "fast", typingSpeed: "fluent",
    pauseFrequency: 80, jitterAmount: 1,
    keystrokeDelayMs: 35, hoverDwellMs: 70,
  },
];

function hashEmail(email: string): number {
  const normalized = email.trim().toLowerCase();
  const digest = crypto.createHash("sha256").update(normalized).digest();
  return digest.readUInt32BE(0);
}

/**
 * Get the deterministic interaction pattern for an email.
 * Same email → same pattern every call.
 */
export function getInteractionPattern(email: string): InteractionPattern {
  const idx = hashEmail(email) % PATTERNS.length;
  return { ...PATTERNS[idx] };
}

/**
 * Logged variant — returns the pattern and emits a one-line summary.
 */
export function getInteractionPatternWithLog(
  email: string,
  logFn?: (msg: string) => void
): InteractionPattern {
  const p = getInteractionPattern(email);
  const msg = `Interaction: ${email} → ${p.name} (mouse=${p.mouseSpeed}, type=${p.typingSpeed}, kbd=${p.keystrokeDelayMs}ms)`;
  if (logFn) logFn(msg);
  return p;
}

/**
 * Compute a randomized inter-action pause for this pattern.
 * Result is `pauseFrequency` jittered to ±50% of its base value.
 * Pure function — caller owns the actual `await sleep(...)`.
 */
export function getActionDelayMs(pattern: InteractionPattern): number {
  const base = pattern.pauseFrequency;
  const jitter = (Math.random() - 0.5) * base; // ±50%
  return Math.max(20, Math.round(base + jitter));
}

/**
 * Compute a per-keystroke delay for `page.type(..., { delay })`.
 * Adds ±25% jitter so the cadence isn't perfectly periodic.
 */
export function getKeystrokeDelayMs(pattern: InteractionPattern): number {
  const base = pattern.keystrokeDelayMs;
  const jitter = (Math.random() - 0.5) * base * 0.5; // ±25%
  return Math.max(10, Math.round(base + jitter));
}

/**
 * Compute a hover dwell time before a click.
 * Power users barely linger; deliberate users sit on the button for ~300ms.
 */
export function getHoverDwellMs(pattern: InteractionPattern): number {
  const base = pattern.hoverDwellMs;
  const jitter = (Math.random() - 0.5) * base * 0.5;
  return Math.max(20, Math.round(base + jitter));
}

/**
 * Pixel offset to apply to a click/hover target so coordinates aren't
 * perfectly centred (real users miss centre by a few pixels).
 */
export function getCursorJitter(pattern: InteractionPattern): { dx: number; dy: number } {
  const j = pattern.jitterAmount;
  if (j <= 0) return { dx: 0, dy: 0 };
  return {
    dx: Math.round((Math.random() - 0.5) * 2 * j),
    dy: Math.round((Math.random() - 0.5) * 2 * j),
  };
}

/** All known patterns, for tests / diagnostics. */
export function listInteractionPatterns(): readonly InteractionPattern[] {
  return PATTERNS;
}

/** Number of patterns in the rotation. */
export function getInteractionPatternPoolSize(): number {
  return PATTERNS.length;
}

