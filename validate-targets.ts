/**
 * validate-targets.ts
 * One-shot CLI that runs the engine against the first N rows of credentials.csv
 * (or specific emails passed as args). Bypasses the WebSocket dashboard.
 *
 * Examples:
 *   npx tsx validate-targets.ts            # first 1 row
 *   npx tsx validate-targets.ts 3          # first 3 rows
 *   npx tsx validate-targets.ts foo@x.com bar@y.com
 */
import "dotenv/config";
import { AutomationEngine, DEFAULT_TARGETS, type EngineConfig, type Credential } from "./engine";
import { BACKEND } from "./cloak-backend";

const DEFAULT_CSV_PATH = "credentials.csv";

function pickCreds(all: Credential[], args: string[]): Credential[] {
  if (args.length === 0) return all.slice(0, 1);
  // If first arg is a positive integer, treat as count
  if (args.length === 1 && /^\d+$/.test(args[0])) {
    const n = parseInt(args[0], 10);
    return all.slice(0, n);
  }
  // Otherwise treat all args as emails
  const wanted = new Set(args.map(a => a.toLowerCase()));
  return all.filter(c => wanted.has(c.email.toLowerCase()));
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const resume = rawArgs.includes("--resume");
  const csvArg = rawArgs.find(a => a.startsWith("--csv="));
  const csvPath = csvArg ? csvArg.slice("--csv=".length) : DEFAULT_CSV_PATH;
  const args = rawArgs.filter(a => a !== "--resume" && !a.startsWith("--csv="));
  const engine = new AutomationEngine();

  // Stream events to console
  engine.on("log", (l: any) => {
    const t = new Date().toLocaleTimeString();
    console.log(`[${t}] [${l.level}] ${l.message}`);
  });
  engine.on("row-update", (r: any) => {
    const sites = Object.entries(r.sites)
      .map(([n, s]: any) => `${n}=${s.outcome}${s.attempts ? `(${s.attempts})` : ""}`)
      .join(" ");
    console.log(`  → ROW ${r.rowIndex} ${r.email} | status=${r.status} | ${sites}`);
  });
  engine.on("started", (d: any) => console.log(`▶ STARTED total=${d.total} targets=${d.targets.join(",")}`));
  engine.on("complete", () => console.log(`✓ COMPLETE`));

  const all = engine.loadCredentials(csvPath);
  if (all.length === 0) {
    console.error(`No credentials loaded from ${csvPath}`);
    process.exit(1);
  }
  const creds = pickCreds(all, args);
  if (creds.length === 0) {
    console.error(`No matching credentials. Args: ${JSON.stringify(args)}`);
    process.exit(1);
  }

  console.log(`Backend: ${BACKEND}`);
  console.log(`Selected ${creds.length} credential(s):`);
  for (const c of creds) console.log(`  - ${c.email} (${c.passwords.length} pw)`);
  console.log("");

  const config: EngineConfig = {
    apiKey: process.env.BROWSERBASE_API_KEY || "",
    projectId: process.env.BROWSERBASE_PROJECT_ID || "",
    concurrency: Math.min(creds.length, 3),
    maxRetries: 1,
    targets: DEFAULT_TARGETS,
    resume,
  };
  if (resume) console.log("Resume: enabled (will skip rows already marked done in progress.json)");

  await engine.start(creds, config);

  // Print final summary
  console.log("\n━━━ FINAL OUTCOMES ━━━");
  for (const r of (engine as any).rows) {
    for (const [site, s] of Object.entries(r.sites) as any) {
      console.log(`  ${r.email} | ${site} | ${s.outcome} | attempts=${s.attempts} | err=${(s.error || "").substring(0, 60)}`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });

