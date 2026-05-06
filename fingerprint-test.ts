/**
 * FINGERPRINT.COM SUSPECT-SCORE PROBE
 * Spawns N sessions on the selected backend, loads demo.fingerprint.com/playground,
 * captures the Pro API JSON (Smart Signals + Bot Detection), and writes results to
 * fingerprint-results.json + fingerprint-screenshots/.
 *
 * Backend: BACKEND=cloak | browserbase   (default: browserbase)
 *   - cloak     → local CloakBrowser (real Chromium, C++ stealth patches, no JS Proxies)
 *   - browserbase → cloud Browserbase + ./stealth.ts JS-layer patches
 *
 * Usage: BACKEND=cloak npx tsx fingerprint-test.ts [num_sessions]
 */
import "dotenv/config";
import Browserbase from "@browserbasehq/sdk";
import { type Page } from "playwright-core";
import * as fs from "fs";
import * as path from "path";
import { applyStealth } from "./stealth";
import { createSession, BACKEND, PROXY_INFO } from "./cloak-backend";

const API_KEY = (process.env.BROWSERBASE_API_KEY || "").trim();
const PROJECT_ID = (process.env.BROWSERBASE_PROJECT_ID || "").trim();
const NUM_SESSIONS = parseInt(process.argv[2] || "3", 10);

const OUT_DIR = path.join(process.cwd(), "fingerprint-screenshots");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

interface Capture {
  sessionIdx: number;
  sessionId: string;
  recordingUrl: string;
  visitorId?: string;
  bot?: any;
  smartSignals?: any;
  rawJsonHits: any[];
  pageText?: string;
  error?: string;
}

async function probeOnce(idx: number, bb: Browserbase | null): Promise<Capture> {
  const cap: Capture = { sessionIdx: idx, sessionId: "", recordingUrl: "", rawJsonHits: [] };
  let handle: Awaited<ReturnType<typeof createSession>> | null = null;
  try {
    handle = await createSession({
      bb: bb || undefined,
      projectId: PROJECT_ID || undefined,
      viewport: { width: 1920, height: 1080 },
      slowMo: 250,
    });
    cap.sessionId = handle.sessionId;
    cap.recordingUrl = handle.recordingUrl;
    const seedTag = handle.fingerprintSeed != null ? ` seed=${handle.fingerprintSeed}` : "";
    console.log(`\n[${idx}] [${BACKEND}] session ${handle.sessionId}${seedTag}${handle.recordingUrl ? " → " + handle.recordingUrl : ""}`);

    const page: Page = handle.page;
    page.setDefaultTimeout(60000);

    // ── Network capture: look for FingerprintJS Pro API JSON ──
    page.on("response", async (response) => {
      try {
        const url = response.url();
        const ct = (response.headers()["content-type"] || "").toLowerCase();
        if (!ct.includes("json")) return;
        if (!/fpjs|fingerprint|api\.fp/i.test(url)) return;
        const body = await response.json();
        if (body && (body.visitorId || body.products || body.bot || body.botd)) {
          cap.rawJsonHits.push({ url: url.substring(0, 120), body });
        }
      } catch { /* ignore */ }
    });

    // CloakBrowser ships native C++ canvas/WebGL/audio/font/automation patches,
    // so the JS-Proxy applyStealth() is skipped — it would only raise tampering signals.
    if (BACKEND !== "cloak") {
      await applyStealth(page);
    }

    console.log(`[${idx}] navigating to demo.fingerprint.com/playground …`);
    await page.goto("https://demo.fingerprint.com/playground", { waitUntil: "domcontentloaded", timeout: 60000 });
    // Wait for FP to fully analyze (it makes multiple calls)
    await page.waitForTimeout(12000);

    // Reproduce FP's audio fingerprint test in main frame to verify our patches are live
    const audioCheck = await page.evaluate(async () => {
      try {
        const ctx = new OfflineAudioContext(1, 5000, 44100);
        const osc = ctx.createOscillator();
        osc.type = "triangle"; osc.frequency.value = 10000;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -50; comp.knee.value = 40; comp.ratio.value = 12;
        comp.attack.value = 0; comp.release.value = 0.25;
        osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
        const buf = await ctx.startRendering();
        const data = buf.getChannelData(0);
        let sum = 0; for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
        return { sum, sample0: data[0], len: data.length, navHC: navigator.hardwareConcurrency, navWD: (navigator as any).webdriver };
      } catch (e: any) { return { error: e.message }; }
    });
    console.log(`[${idx}] AUDIO-PROBE: ${JSON.stringify(audioCheck)}`);

    // Try to extract the visible result panel text
    cap.pageText = await page.evaluate(() => {
      const grab = (sel: string) => Array.from(document.querySelectorAll(sel)).map((e) => (e as HTMLElement).innerText).join("\n");
      return grab("main") || document.body.innerText;
    }).catch(() => "");

    // Pull structured signals from network hits
    for (const hit of cap.rawJsonHits) {
      const b = hit.body;
      if (b.visitorId && !cap.visitorId) cap.visitorId = b.visitorId;
      if (b.products) cap.smartSignals = b.products;
      if (b.bot || b.botd) cap.bot = b.bot || b.botd;
      if (b.products?.botd) cap.bot = b.products.botd;
    }

    const shotPath = path.join(OUT_DIR, `session-${idx}-${handle.sessionId.replace(/[^a-z0-9-]/gi, "_")}.jpg`);
    await page.screenshot({ path: shotPath, type: "jpeg", quality: 80, fullPage: true });
    console.log(`[${idx}] screenshot → ${shotPath}`);
  } catch (e: any) {
    cap.error = e.message || String(e);
    console.error(`[${idx}] ERROR: ${cap.error}`);
  } finally {
    if (handle) await handle.close().catch(() => { });
  }
  return cap;
}

(async () => {
  let bb: Browserbase | null = null;
  if (BACKEND === "browserbase") {
    if (!API_KEY || !PROJECT_ID) { console.error("Missing BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID"); process.exit(1); }
    bb = new Browserbase({ apiKey: API_KEY });
  } else {
    console.log(`Backend: cloak | proxy: ${PROXY_INFO}`);
  }
  console.log(`Running ${NUM_SESSIONS} fingerprint probes on backend=${BACKEND}…`);
  const results: Capture[] = [];
  for (let i = 1; i <= NUM_SESSIONS; i++) {
    const cap = await probeOnce(i, bb);
    results.push(cap);
    // Print compact summary inline
    console.log(`\n=== [${i}] SUMMARY ===`);
    console.log(`visitorId: ${cap.visitorId || "(none)"}`);
    if (cap.bot) console.log(`bot: ${JSON.stringify(cap.bot).substring(0, 300)}`);
    if (cap.smartSignals) {
      const ss = cap.smartSignals;
      const keys = Object.keys(ss);
      console.log(`signals: ${keys.join(", ")}`);
      for (const k of keys) {
        const v = ss[k];
        if (v?.data) console.log(`  ${k}: ${JSON.stringify(v.data).substring(0, 200)}`);
      }
    }
    if (cap.error) console.log(`ERROR: ${cap.error}`);
  }
  fs.writeFileSync("fingerprint-results.json", JSON.stringify(results, null, 2), "utf-8");
  console.log(`\n✅ Wrote fingerprint-results.json (${results.length} sessions)`);
})();

