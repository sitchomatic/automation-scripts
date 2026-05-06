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
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { launchContext } from "cloakbrowser";

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

/** Picks a proxy for this session: pool > single URL > none. Random sticky-session per call. */
export function pickProxy(): string | undefined {
  if (PROXY_POOL.length > 0) return PROXY_POOL[Math.floor(Math.random() * PROXY_POOL.length)];
  return AU_PROXY_URL || undefined;
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
}

async function createCloakSession(opts: SessionOpts): Promise<SessionHandle> {
  const viewport = opts.viewport || { width: 1920, height: 1080 };
  const slowMo = opts.slowMo ?? 250;
  const seed = opts.fingerprintSeed ?? Math.floor(Math.random() * 89999) + 10000;
  const sessionId = `cloak-${crypto.randomUUID().slice(0, 8)}-${seed}`;
  const proxy = pickProxy();

  const context = await launchContext({
    headless: opts.headless ?? true,
    proxy,
    geoip: !!proxy,                          // auto TZ/locale/WebRTC IP from proxy exit
    humanize: true,                          // human mouse curves + keystroke timing
    viewport,
    args: [
      `--fingerprint=${seed}`,
      "--fingerprint-platform=windows",      // spoof Windows even though we run on Windows — keeps it deterministic per-seed
    ],
    launchOptions: { slowMo },
  });

  const page = context.pages()[0] || (await context.newPage());

  return {
    context,
    page,
    sessionId,
    recordingUrl: "",
    backend: "cloak",
    fingerprintSeed: seed,
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
  const slowMo = opts.slowMo ?? 250;

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
  const context = browser.contexts()[0];
  const page = context.pages()[0];

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

