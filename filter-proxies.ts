/**
 * filter-proxies.ts
 * Probes every sticky session in the LiveProxies pool, classifies each by:
 *   1. exit IP + ASN (ipinfo.io via the proxy)
 *   2. proxy/VPN reputation (proxycheck.io, no-key tier — 1000/day free)
 * Writes clean residential AU exits to `liveproxies-clean.txt`.
 *
 * Run:  npx tsx filter-proxies.ts
 */
import "dotenv/config";
import * as fs from "fs";
import * as https from "https";
import { HttpsProxyAgent } from "https-proxy-agent";

const POOL_PATH = (process.env.AU_PROXY_FILE || "").trim();
const OUT_PATH = "liveproxies-clean.txt";
const META_PATH = "liveproxies-meta.json";
const CONCURRENCY = 10;
const TIMEOUT_MS = 15000;

type Probe = {
  raw: string;
  url: string;
  ok: boolean;
  exit_ip?: string;
  asn?: string;
  city?: string;
  country?: string;
  pc_proxy?: string;
  pc_type?: string;
  clean?: boolean;
  err?: string;
};

function buildUrl(line: string): string {
  if (/^(https?|socks5):\/\//i.test(line)) return line;
  const parts = line.split(":");
  if (parts.length < 4) throw new Error(`Bad proxy line: ${line}`);
  const [host, port, user, ...rest] = parts;
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(rest.join(":"))}@${host}:${port}`;
}

async function fetchJson(url: string, agent?: any): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, dispatcher: agent } as any);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function probe(line: string, idx: number, total: number): Promise<Probe> {
  const url = buildUrl(line);
  const out: Probe = { raw: line, url, ok: false };
  try {
    const agent = new HttpsProxyAgent(url);
    // 1. ipinfo via proxy → exit IP
    const info = await new Promise<any>((resolve, reject) => {
      const req = https.get("https://ipinfo.io/json", { agent, timeout: TIMEOUT_MS } as any, (res: any) => {
        let buf = ""; res.on("data", (c: any) => buf += c);
        res.on("end", () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(new Error("timeout")); });
    });
    out.exit_ip = info.ip;
    out.asn = info.org;
    out.city = info.city;
    out.country = info.country;

    // 2. proxycheck.io reputation (direct, no proxy)
    const pc = await fetchJson(`https://proxycheck.io/v2/${info.ip}?vpn=1&asn=0`).catch(() => null);
    if (pc && pc[info.ip]) {
      out.pc_proxy = pc[info.ip].proxy;
      out.pc_type = pc[info.ip].type;
    }
    // Clean criteria: AU + proxycheck says proxy=no (or no data) + ASN not a known hosting/datacenter org
    const isAU = out.country === "AU";
    const pcSaysClean = out.pc_proxy !== "yes";
    const orgLooksISP = !/(hosting|datacenter|server|cloud|digital ocean|amazon|google|microsoft|ovh|hetzner|linode|vultr|leaseweb|m247)/i.test(out.asn || "");
    out.clean = isAU && pcSaysClean && orgLooksISP;
    out.ok = true;
  } catch (e: any) {
    out.err = (e.message || String(e)).substring(0, 80);
  }
  const tag = out.clean ? "✅" : out.ok ? "⚠️ " : "❌";
  console.log(`[${idx + 1}/${total}] ${tag} ${out.exit_ip || "?"} | ${out.asn || out.err} | pc=${out.pc_proxy || "?"}`);
  return out;
}

async function main() {
  if (!POOL_PATH || !fs.existsSync(POOL_PATH)) {
    console.error(`AU_PROXY_FILE not set or missing: ${POOL_PATH}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(POOL_PATH, "utf-8").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  console.log(`Probing ${lines.length} proxies (concurrency=${CONCURRENCY})…\n`);

  const results: Probe[] = new Array(lines.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < lines.length) {
      const i = cursor++;
      results[i] = await probe(lines[i], i, lines.length);
    }
  }));

  const clean = results.filter(r => r.clean).map(r => r.raw);
  fs.writeFileSync(OUT_PATH, clean.join("\n") + "\n", "utf-8");
  fs.writeFileSync(META_PATH, JSON.stringify(results, null, 2), "utf-8");

  const ok = results.filter(r => r.ok).length;
  const auCount = results.filter(r => r.country === "AU").length;
  const pcClean = results.filter(r => r.pc_proxy && r.pc_proxy !== "yes").length;
  console.log("\n━━━ SUMMARY ━━━");
  console.log(`Total probed:        ${results.length}`);
  console.log(`Reachable:           ${ok}`);
  console.log(`AU geo:              ${auCount}`);
  console.log(`proxycheck clean:    ${pcClean}`);
  console.log(`✅ Final clean pool: ${clean.length} → ${OUT_PATH}`);
  console.log(`Full metadata:       ${META_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });

