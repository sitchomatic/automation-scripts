import "dotenv/config";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { launchContext } from "cloakbrowser";
import { applyStealth } from "./stealth.js";
import { DEFAULT_TARGETS } from "./engine.js";
import { pickProxy } from "./cloak-backend.js";

type Mode = "No_Stealth" | "JS_Stealth" | "Cloak_Native";

async function parseProxy(proxyUrl: string | undefined) {
  if (!proxyUrl) return undefined;
  const url = new URL(proxyUrl);
  return {
    server: `${url.protocol}//${url.host}`,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

async function createSession(mode: Mode): Promise<{ context: BrowserContext; page: Page; close: () => Promise<void> }> {
  const proxyUrl = pickProxy([]);
  const proxy = await parseProxy(proxyUrl);

  if (mode === "No_Stealth" || mode === "JS_Stealth") {
    const browser = await chromium.launch({
      headless: true,
      proxy: proxy ? { server: proxy.server, username: proxy.username, password: proxy.password } : undefined,
      args: ["--disable-blink-features=AutomationControlled"]
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    if (mode === "JS_Stealth") {
      await applyStealth(page);
    }
    return { context, page, close: async () => { await browser.close(); } };
  } else {
    // Cloak Native
    const context = await launchContext({
      headless: true,
      proxy: proxyUrl,
      geoip: !!proxyUrl,
      humanize: true,
      args: [
        "--fingerprint=12345",
        "--fingerprint-platform=windows",
        "--disable-blink-features=AutomationControlled",
        "--use-gl=angle",
        "--enable-features=Vulkan",
        "--disable-features=IsolateOrigins,site-per-process,UserAgentClientHint",
        "--enable-accelerated-2d-canvas",
        "--enable-accelerated-video-decode",
        "--ignore-gpu-blocklist",
        "--metrics-recording-only",
      ]
    });
    const page = context.pages()[0] || (await context.newPage());
    return { context, page, close: async () => { await context.close(); } };
  }
}

async function measureLoginResponse(mode: Mode, target: typeof DEFAULT_TARGETS[0]): Promise<number | null> {
  const session = await createSession(mode);
  const page = session.page;
  page.setDefaultTimeout(30000);

  try {
    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Dismiss cookie
    try {
      const btn = page.locator('button', { hasText: /accept all/i }).first();
      if (await btn.isVisible({ timeout: 3000 })) {
        await btn.click();
        await new Promise(r => setTimeout(r, 500));
      }
    } catch {}

    const u = await page.locator(target.selectors.username).first();
    const p = await page.locator(target.selectors.password).first();
    const s = await page.locator(target.selectors.submit).first();
    
    await u.fill("test_user_benchmark@example.com");
    await new Promise(r => setTimeout(r, 500));
    await p.fill("wrong_password_123!");
    await new Promise(r => setTimeout(r, 500));

    let responded = false;
    page.on("response", async (res) => {
      try {
        const ct = (res.headers()["content-type"] || "").toLowerCase();
        if (ct.includes("text") || ct.includes("json") || ct.includes("html")) {
          const body = await res.text();
          const lower = body.toLowerCase();
          if (lower.includes("incorrect") || lower.includes("temporarily disabled") || lower.includes("been disabled")) {
            responded = true;
          }
        }
      } catch {}
    });

    const start = performance.now();
    await s.click();

    // Poll for DOM changes or network response
    let elapsed = 0;
    while (!responded && elapsed < 15000) {
      const isSuccess = await page.evaluate(() => !!document.querySelector('.ol-alert__content--status_success')).catch(() => false);
      if (isSuccess) responded = true;
      if (responded) break;
      await new Promise(r => setTimeout(r, 50));
      elapsed = performance.now() - start;
    }

    const end = performance.now();
    return responded ? (end - start) : null;

  } catch (e: any) {
    console.error(`[${mode}] Error on ${target.name}:`, e.message);
    return null;
  } finally {
    await session.close();
  }
}

async function runBenchmark() {
  const modes: Mode[] = ["No_Stealth", "JS_Stealth", "Cloak_Native"];
  const runs = 3;

  for (const target of DEFAULT_TARGETS) {
    console.log(`\n=== Benchmarking target: ${target.name} ===`);
    for (const mode of modes) {
      const times: number[] = [];
      for (let i = 0; i < runs; i++) {
        process.stdout.write(`  [${mode}] Run ${i+1}/${runs}... `);
        const time = await measureLoginResponse(mode, target);
        if (time !== null) {
          times.push(time);
          console.log(`${time.toFixed(0)} ms`);
        } else {
          console.log(`Timeout / Failed`);
        }
      }
      
      if (times.length > 0) {
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        console.log(`  -> Average for ${mode}: ${avg.toFixed(0)} ms`);
      } else {
        console.log(`  -> Average for ${mode}: N/A`);
      }
    }
  }
}

runBenchmark().catch(console.error);
