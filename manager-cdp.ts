/**
 * Patchright ⇄ CloakBrowser-Manager helper.
 *
 * Connects Patchright (CDP) to a profile running inside the local
 * CloakBrowser-Manager. The Manager exposes each profile's Chrome DevTools
 * Protocol over a WebSocket proxy at /api/profiles/<id>/cdp, with HTTP
 * /json/version returning the rewritten WS URL — exactly what
 * `chromium.connectOverCDP(<http url>)` expects.
 *
 * Env:
 *   MANAGER_URL    base URL of the Manager (default: http://localhost:8080)
 *   MANAGER_TOKEN  optional bearer token (matches the Manager's AUTH_TOKEN)
 */
import "dotenv/config";
import { chromium, type Browser, type BrowserContext, type Page } from "patchright";

export const MANAGER_URL = (process.env.MANAGER_URL || "http://localhost:8080").replace(/\/+$/, "");
export const MANAGER_TOKEN = (process.env.MANAGER_TOKEN || "").trim();

export interface ManagerProfile {
  id: string;
  name: string;
  status: "running" | "stopped";
  cdp_url: string | null;
  [key: string]: unknown;
}

export interface ManagerHandle {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  profile: ManagerProfile;
  cdpHttpUrl: string;
  close: () => Promise<void>;
}

export interface ConnectOpts {
  /** Profile UUID. Takes precedence over `profileName`. */
  profileId?: string;
  /** Profile name (case-sensitive exact match). Resolved via /api/profiles. */
  profileName?: string;
  /** If the profile isn't running, POST /launch and wait for it. Default true. */
  autoStart?: boolean;
  /** Max ms to wait for the profile to reach "running" after launch. Default 30_000. */
  startTimeoutMs?: number;
  /** Forwarded to Patchright's connectOverCDP. */
  slowMo?: number;
}

function authHeaders(): Record<string, string> {
  return MANAGER_TOKEN ? { Authorization: `Bearer ${MANAGER_TOKEN}` } : {};
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = { Accept: "application/json", ...authHeaders(), ...(init.headers as Record<string, string> | undefined) };
  const res = await fetch(`${MANAGER_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Manager ${init.method || "GET"} ${path} → ${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
  }
  return res.json() as Promise<T>;
}

export async function listProfiles(): Promise<ManagerProfile[]> {
  return api<ManagerProfile[]>("/api/profiles");
}

export async function getProfile(profileId: string): Promise<ManagerProfile> {
  return api<ManagerProfile>(`/api/profiles/${profileId}`);
}

async function launchProfile(profileId: string): Promise<void> {
  await api(`/api/profiles/${profileId}/launch`, { method: "POST" });
}

async function waitForRunning(profileId: string, timeoutMs: number): Promise<ManagerProfile> {
  const deadline = Date.now() + timeoutMs;
  let last: ManagerProfile | null = null;
  while (Date.now() < deadline) {
    last = await getProfile(profileId);
    if (last.status === "running" && last.cdp_url) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Profile ${profileId} did not reach 'running' within ${timeoutMs}ms (last status: ${last?.status})`);
}

async function resolveProfile(opts: ConnectOpts): Promise<ManagerProfile> {
  if (opts.profileId) return getProfile(opts.profileId);
  if (opts.profileName) {
    const all = await listProfiles();
    const hit = all.find((p) => p.name === opts.profileName);
    if (!hit) throw new Error(`No profile named "${opts.profileName}" (have: ${all.map((p) => p.name).join(", ") || "none"})`);
    return hit;
  }
  throw new Error("connectManagerProfile requires either profileId or profileName");
}

/**
 * Connect Patchright to a CloakBrowser-Manager profile over CDP.
 * Returns the underlying Browser plus the first context/page already attached
 * to the running Chrome instance.
 */
export async function connectManagerProfile(opts: ConnectOpts): Promise<ManagerHandle> {
  let profile = await resolveProfile(opts);

  if (profile.status !== "running") {
    if (opts.autoStart === false) throw new Error(`Profile ${profile.id} is not running and autoStart=false`);
    await launchProfile(profile.id);
    profile = await waitForRunning(profile.id, opts.startTimeoutMs ?? 30_000);
  }

  // The Manager's /cdp HTTP path serves Chrome's /json/version with the
  // webSocketDebuggerUrl rewritten to go through the WS proxy. Patchright's
  // connectOverCDP fetches that URL itself.
  const cdpHttpUrl = `${MANAGER_URL}/api/profiles/${profile.id}/cdp`;

  const browser = await chromium.connectOverCDP(cdpHttpUrl, {
    headers: authHeaders(),
    slowMo: opts.slowMo,
  });

  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  return {
    browser,
    context,
    page,
    profile,
    cdpHttpUrl,
    close: async () => {
      // CDP-attached browsers should be detached, not closed — closing would
      // terminate the Chrome instance owned by the Manager.
      await Promise.race([
        browser.close(),
        new Promise((r) => setTimeout(r, 5_000)),
      ]).catch(() => {});
    },
  };
}

