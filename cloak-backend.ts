/**
 * Backend adapter — switches between Browserbase (cloud, Linux) and
 * CloakBrowser (local, real Chromium with C++ source-level stealth patches).
 *
 * Selected via env: BACKEND=cloak | browserbase   (default: browserbase).
 * For cloak: AU_PROXY_URL controls outbound proxy; if empty, runs direct.
 *
 * Returns a uniform SessionHandle so engine.ts and fingerprint-test.ts
 * stay backend-agnostic from the consumer side.
 */
import "dotenv/config";
import * as crypto from "crypto";
import * as fs from "fs";
import Browserbase from "@browserbasehq/sdk";
// playwright-core: shared BrowserContext/Page types (what cloakbrowser's
// launchContext() returns) and the chromium client used to connect to
// Browserbase's cloud-managed browser over CDP.
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { launchContext } from "cloakbrowser";
import { getConsistentHardware, getHardwareArgs, type HardwareProfile } from "./profile-determinism.js";
import { alignGeoToProxy, type GeoProfile } from "./profile-geo-alignment.js";
import {
  buildCredentialNoiseProfile,
  getCanvasNoiseInjectionScript,
  getWebGLNoiseInjectionScript,
  type CredentialNoiseProfile,
} from "./profile-credential-noise.js";
import { getConsistentUserAgent, getUserAgentArgs, type UAProfile } from "./profile-useragent.js";
import { getFontProfile, type FontProfile } from "./profile-fonts.js";
import { getConsistentResolution, getViewport, type Resolution } from "./profile-resolution.js";
import { getInteractionPattern, type InteractionPattern } from "./profile-interaction.js";
import {
  getExtensionProfile,
  getExtensionInjectionScript,
  type ExtensionProfile,
} from "./profile-extensions.js";
import { getCacheProfile, getCacheInjectionScript, type CacheProfile } from "./profile-cache.js";

export type Backend = "cloak" | "browserbase";

export const BACKEND: Backend =
  (process.env.BACKEND || "browserbase").toLowerCase() === "cloak" ? "cloak" : "browserbase";

export const AU_PROXY_URL = (process.env.AU_PROXY_URL || "").trim();
export const AU_PROXY_FILE = (process.env.AU_PROXY_FILE || "").trim();

/**
 * Loads a proxy pool from a file in `host:port:user:pass` format (LiveProxies-style),
 * one entry per line. Each entry is a sticky residential session.
 * Returns full URLs in the form `http://user:pass@host:port`.
 */
function loadProxyPool(): string[] {
  if (!AU_PROXY_FILE) return [];
  try {
    const raw = fs.readFileSync(AU_PROXY_FILE, "utf-8");
    return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
      // Already a URL? pass through
      if (/^(https?|socks5):\/\//i.test(line)) return line;
      const parts = line.split(":");
      if (parts.length < 4) return "";
      const [host, port, user, ...passParts] = parts;
      const pass = passParts.join(":"); // password may contain colons
      return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    }).filter(Boolean);
  } catch (e: any) {
    console.warn(`[cloak-backend] Failed to read AU_PROXY_FILE=${AU_PROXY_FILE}: ${e.message}`);
    return [];
  }
}

const PROXY_POOL: string[] = loadProxyPool();

/** Picks a proxy for this session: pool > single URL > none. Random sticky-session per call.
 *  `exclude` lets a caller skip already-tried proxies during per-row retry. */
export function pickProxy(exclude: string[] = []): string | undefined {
  if (PROXY_POOL.length > 0) {
    const candidates = exclude.length > 0 ? PROXY_POOL.filter((p) => !exclude.includes(p)) : PROXY_POOL;
    const pool = candidates.length > 0 ? candidates : PROXY_POOL; // fall back to full pool if exhausted
    return pool[Math.floor(Math.random() * pool.length)];
  }
  return AU_PROXY_URL || undefined;
}

export function getProxyPoolSize(): number {
  return PROXY_POOL.length;
}

export const PROXY_INFO = (() => {
  if (PROXY_POOL.length > 0) return `pool of ${PROXY_POOL.length} (${AU_PROXY_FILE})`;
  if (AU_PROXY_URL) return `single (${AU_PROXY_URL.replace(/:[^:@/]+@/, ":***@")})`;
  return "none — DIRECT";
})();

export interface SessionHandle {
  context: BrowserContext;
  page: Page;
  sessionId: string;
  recordingUrl: string;          // empty for cloak
  backend: Backend;
  fingerprintSeed?: number;      // cloak only
  proxyUsed?: string;            // proxy URL actually picked for this session (cloak only)
  hardwareProfile?: HardwareProfile;  // Phase-1: deterministic hardware preset (cloak only)
  geoProfile?: GeoProfile;             // Phase-1: timezone/locale aligned to proxy (cloak only)
  noiseProfile?: CredentialNoiseProfile; // Phase-1: per-credential canvas/WebGL/audio noise (cloak only)
  uaProfile?: UAProfile;               // Phase-2: deterministic Chrome/Windows UA per credential (cloak only)
  fontProfile?: FontProfile;           // Phase-2: deterministic font set per credential (cloak only, observability)
  resolutionProfile?: Resolution;      // Phase-2: deterministic viewport per credential (cloak only)
  interactionProfile?: InteractionPattern; // Phase-3: per-credential mouse/typing persona (cloak only)
  extensionProfile?: ExtensionProfile;     // Phase-3: simulated installed extensions (cloak only)
  cacheProfile?: CacheProfile;             // Phase-3: pre-populated localStorage breadcrumbs (cloak only)
  close: () => Promise<void>;
}

export interface SessionOpts {
  bb?: Browserbase;              // required for browserbase
  projectId?: string;            // required for browserbase
  viewport?: { width: number; height: number };
  slowMo?: number;
  fingerprintSeed?: number;      // cloak: deterministic seed; default = random
  headless?: boolean;            // cloak only
  timeoutSec?: number;           // browserbase session timeout
  excludeProxies?: string[];     // cloak only: proxies to skip when picking from pool (per-row retry)
  email?: string;                // Phase-1: enables hardware/geo/noise determinism per credential (cloak only)
}

async function createCloakSession(opts: SessionOpts): Promise<SessionHandle> {
  const slowMo = opts.slowMo ?? 100;
  const seed = opts.fingerprintSeed ?? Math.floor(Math.random() * 89999) + 10000;
  const sessionId = `cloak-${crypto.randomUUID().slice(0, 8)}-${seed}`;
  const proxy = pickProxy(opts.excludeProxies || []);

  // Phase-1 quality profile: deterministic per-credential when email is provided
  const hardwareProfile = opts.email ? getConsistentHardware(opts.email) : undefined;
  const geoProfile = opts.email ? alignGeoToProxy(proxy) : undefined;
  const noiseProfile = opts.email ? buildCredentialNoiseProfile(opts.email) : undefined;
  const hardwareGpuArgs = hardwareProfile ? getHardwareArgs(hardwareProfile) : ["--use-angle=d3d11"];

  // Phase-2 quality profile: UA freshness, font consistency, resolution variety
  const uaProfile = opts.email ? getConsistentUserAgent(opts.email) : undefined;
  const fontProfile = opts.email ? getFontProfile(opts.email) : undefined;
  const resolutionProfile = opts.email ? getConsistentResolution(opts.email) : undefined;
  // Explicit opts.viewport always wins; otherwise use the per-credential resolution; else FHD default.
  const viewport = opts.viewport ?? (resolutionProfile ? getViewport(resolutionProfile) : { width: 1920, height: 1080 });
  // UA-derived binary flags. Falls back to a recent Win10 build when no credential is bound.
  const uaArgs = uaProfile ? getUserAgentArgs(uaProfile) : ["--fingerprint-platform-version=10.0.19045"];

  // Phase-3 quality profile: interaction patterns, extension simulation, cache authenticity
  const interactionProfile = opts.email ? getInteractionPattern(opts.email) : undefined;
  const extensionProfile = opts.email ? getExtensionProfile(opts.email) : undefined;
  const cacheProfile = opts.email ? getCacheProfile(opts.email, uaProfile?.chromeMajor) : undefined;

  // Build base launch args. Hardware-derived GPU arg replaces the static d3d11 default.
  const launchArgs = [
    `--fingerprint=${seed}`,
    "--fingerprint-platform=windows",      // spoof Windows — deterministic per-seed
    ...uaArgs,                             // Phase-2: --fingerprint-platform-version + --fingerprint-browser-version
    // VM-detection mitigation: hide signals FP uses to flip virtual_machine: true
    "--disable-blink-features=AutomationControlled",
    "--use-gl=angle",                      // force ANGLE so WebGL renderer looks like real GPU
    ...hardwareGpuArgs,                    // d3d11 (Intel) | opengl (NVIDIA) | vulkan (AMD)
    "--enable-features=Vulkan",            // advertise Vulkan support (hardware hosts have it)
    "--disable-features=IsolateOrigins,site-per-process,UserAgentClientHint",
    "--enable-accelerated-2d-canvas",
    "--enable-accelerated-video-decode",
    "--ignore-gpu-blocklist",
    "--disable-popup-blocking",
    "--disable-background-networking",
    "--metrics-recording-only",
  ];

  // HEADLESS env override (default true). Set HEADLESS=false to see windows.
  const envHeadless = (process.env.HEADLESS ?? "true").toLowerCase() !== "false";
  const context = await launchContext({
    headless: opts.headless ?? envHeadless,
    proxy,
    geoip: !!proxy,                          // auto TZ/locale/WebRTC IP from proxy exit
    humanize: true,                          // human mouse curves + keystroke timing
    viewport,
    // Phase-1: explicit timezone/locale aligned to proxy exit IP. cloakbrowser
    // uses these alongside geoip to keep Intl/Date/WebRTC consistent.
    ...(geoProfile ? { timezone: geoProfile.timezone, locale: geoProfile.locale } : {}),
    args: launchArgs,
    launchOptions: { slowMo },
  });

  // Per-credential init scripts. Each is ADDITIVE (defines new properties or
  // seeds empty localStorage keys) so it doesn't conflict with cloakbrowser's
  // native C++ patches. Runs at document_start before any site JS.
  if (noiseProfile) {
    await context.addInitScript({ content: getCanvasNoiseInjectionScript(noiseProfile) });
    await context.addInitScript({ content: getWebGLNoiseInjectionScript(noiseProfile) });
  }
  if (extensionProfile) {
    await context.addInitScript({ content: getExtensionInjectionScript(extensionProfile) });
  }
  if (cacheProfile) {
    await context.addInitScript({ content: getCacheInjectionScript(cacheProfile) });
  }

  const page = context.pages()[0] ?? (await context.newPage());

  return {
    context,
    page,
    sessionId,
    recordingUrl: "",
    backend: "cloak",
    fingerprintSeed: seed,
    proxyUsed: proxy,
    hardwareProfile,
    geoProfile,
    noiseProfile,
    uaProfile,
    fontProfile,
    resolutionProfile,
    interactionProfile,
    extensionProfile,
    cacheProfile,
    close: async () => {
      await context.close().catch(() => { });
    },
  };
}

async function createBrowserbaseSession(opts: SessionOpts): Promise<SessionHandle> {
  if (!opts.bb || !opts.projectId) {
    throw new Error("browserbase backend requires { bb, projectId }");
  }
  const viewport = opts.viewport || { width: 1920, height: 1080 };
  const slowMo = opts.slowMo ?? 100;

  let session: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      session = await opts.bb.sessions.create({
        projectId: opts.projectId,
        region: "ap-southeast-1",
        proxies: [{ type: "browserbase", geolocation: { country: "AU", city: "Melbourne" } }],
        browserSettings: { recordSession: true, logSession: true, viewport },
        timeout: opts.timeoutSec ?? 300,
        keepAlive: false,
      });
      break;
    } catch (e: any) {
      const msg = e.message || String(e);
      if (attempt < 3 && (msg.includes("concurrent") || msg.includes("429") || msg.includes("limit"))) {
        await new Promise((r) => setTimeout(r, 5000 * attempt + Math.random() * 3000));
        continue;
      }
      throw e;
    }
  }
  if (!session) throw new Error("Failed to create Browserbase session after 3 attempts");

  const browser = await chromium.connectOverCDP(session.connectUrl, { slowMo });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  return {
    context,
    page,
    sessionId: session.id,
    recordingUrl: `https://www.browserbase.com/sessions/${session.id}`,
    backend: "browserbase",
    close: async () => {
      await Promise.race([
        browser.close(),
        new Promise((r) => setTimeout(r, 5000)),
      ]).catch(() => { });
    },
  };
}

export async function createSession(opts: SessionOpts): Promise<SessionHandle> {
  return BACKEND === "cloak" ? createCloakSession(opts) : createBrowserbaseSession(opts);
}

