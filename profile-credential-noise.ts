/**
 * Canvas/WebGL Noise Per-Credential
 * Seeds canvas and WebGL noise deterministically from email hash.
 * Same credential produces consistent fingerprint across sessions.
 */

import * as crypto from "crypto";

/**
 * Derive a deterministic noise seed from email address.
 * Same email → same seed → same noise → same fingerprint.
 */
export function deriveNoiseSeedFromEmail(email: string): number {
  const normalized = email.trim().toLowerCase();
  const hash = crypto.createHash("sha256").update(normalized).digest();
  const value = hash.readUInt32BE(0);
  return Math.abs(value);
}

export interface CanvasNoiseParams {
  pixelNoise: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Generate canvas noise parameters from credential noise seed.
 */
export function getCanvasNoiseParams(email: string): CanvasNoiseParams {
  const seed = deriveNoiseSeedFromEmail(email);
  return {
    pixelNoise: ((seed % 1000) + 1) * 0.0001,
    offsetX: (seed % 256),
    offsetY: ((seed >>> 8) % 256),
  };
}

export interface WebGLNoiseParams {
  variance: number;
  colorShift: number;
}

/**
 * Generate WebGL noise parameters from credential noise seed.
 */
export function getWebGLNoiseParams(email: string): WebGLNoiseParams {
  const seed = deriveNoiseSeedFromEmail(email);
  return {
    variance: ((seed % 1000) + 1) * 0.001,
    colorShift: (seed % 360),
  };
}

export interface AudioNoiseParams {
  frequencyShift: number;
  amplitudeVariance: number;
}

/**
 * Generate audio noise parameters from credential noise seed.
 */
export function getAudioNoiseParams(email: string): AudioNoiseParams {
  const seed = deriveNoiseSeedFromEmail(email);
  return {
    frequencyShift: ((seed % 100) - 50) * 0.001,
    amplitudeVariance: ((seed % 1000) * 0.0001) - 0.05,
  };
}

export interface CredentialNoiseProfile {
  email: string;
  noiseSeed: number;
  canvas: CanvasNoiseParams;
  webgl: WebGLNoiseParams;
  audio: AudioNoiseParams;
}

/**
 * Compute full noise profile for a credential.
 */
export function buildCredentialNoiseProfile(email: string): CredentialNoiseProfile {
  const noiseSeed = deriveNoiseSeedFromEmail(email);
  return {
    email,
    noiseSeed,
    canvas: getCanvasNoiseParams(email),
    webgl: getWebGLNoiseParams(email),
    audio: getAudioNoiseParams(email),
  };
}

/**
 * JavaScript code to inject into pages for canvas noise injection.
 */
export function getCanvasNoiseInjectionScript(profile: CredentialNoiseProfile): string {
  const { noiseSeed, canvas } = profile;
  return `
(function() {
  const noiseSeed = ${noiseSeed};
  const pixelNoise = ${canvas.pixelNoise};
  const offsetX = ${canvas.offsetX};
  const offsetY = ${canvas.offsetY};

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function() {
    try {
      const ctx = this.getContext('2d');
      if (ctx) {
        const w = this.width, h = this.height;
        if (w > 0 && h > 0) {
          const x = offsetX % w, y = offsetY % h;
          ctx.fillStyle = 'rgba(1,1,1,' + pixelNoise + ')';
          ctx.fillRect(x, y, 1, 1);
        }
      }
    } catch (e) {}
    return origToDataURL.call(this);
  };
})();
  `;
}

/**
 * JavaScript code for WebGL noise injection.
 */
export function getWebGLNoiseInjectionScript(profile: CredentialNoiseProfile): string {
  const { webgl } = profile;
  return `
(function() {
  const variance = ${webgl.variance};
  const colorShift = ${webgl.colorShift};

  if (window.WebGLRenderingContext) {
    const origGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(pname) {
      const result = origGetParameter.call(this, pname);
      if (pname === WebGLRenderingContext.UNMASKED_RENDERER_WEBGL && result) {
        return result.replace(/ANGLE|Adreno|Mali/, 'GPU');
      }
      return result;
    };
  }
})();
  `;
}

