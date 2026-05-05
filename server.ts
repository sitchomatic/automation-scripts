/**
 * GUI SERVER
 * Express + WebSocket server that serves the dashboard frontend
 * and relays real-time automation events.
 */
import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import {
  AutomationEngine,
  DEFAULT_TARGETS,
  type Credential,
  type EngineConfig,
} from "./engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3000", 10);
const CSV_PATH = path.resolve("credentials.csv");

const API_KEY = process.env.BROWSERBASE_API_KEY || "";
const PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID || "";

// ─── App Setup ────────────────────────────────────────────────────────────────

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const engine = new AutomationEngine();
let cachedCredentials: Credential[] = engine.loadCredentials(CSV_PATH);

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// ─── WebSocket Handling ───────────────────────────────────────────────────────

function broadcast(data: object): void {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// Forward engine events to all WebSocket clients
engine.on("started", (data) => broadcast({ type: "started", data }));
engine.on("row-update", (data) => broadcast({ type: "row-update", data }));
engine.on("log", (data) => broadcast({ type: "log", data }));
engine.on("complete", (data) => broadcast({ type: "complete", data }));
engine.on("stopping", () => broadcast({ type: "stopping" }));
engine.on("screenshot", (data) => broadcast({ type: "screenshot", data }));

wss.on("connection", (ws) => {
  console.log("[Server] Client connected");

  // Send initial state (use cached credentials)
  const credentials = cachedCredentials;
  ws.send(
    JSON.stringify({
      type: "init",
      data: {
        credentials: credentials.map((c) => ({ email: c.email })),
        config: {
          apiKey: API_KEY ? `${API_KEY.substring(0, 12)}...` : "",
          projectId: PROJECT_ID ? `${PROJECT_ID.substring(0, 8)}...` : "",
          hasApiKey: !!API_KEY,
          hasProjectId: !!PROJECT_ID,
          concurrency: 3, // default 3, engine caps at max 5
          maxRetries: 2,
          targets: DEFAULT_TARGETS.map((t) => t.name),
        },
        isRunning: engine.isRunning,
        rows: engine.rowStatuses,
      },
    })
  );

  // Handle messages from client
  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        case "start": {
          if (engine.isRunning) {
            ws.send(JSON.stringify({ type: "error", data: { message: "Already running" } }));
            return;
          }

          if (!API_KEY || !PROJECT_ID) {
            ws.send(
              JSON.stringify({
                type: "error",
                data: { message: "Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID. Set them in .env file." },
              })
            );
            return;
          }

          const credentials = cachedCredentials;
          if (credentials.length === 0) {
            ws.send(
              JSON.stringify({ type: "error", data: { message: "No credentials found in credentials.csv" } })
            );
            return;
          }

          // Default 3 concurrent credentials. Engine clamps to absolute max of 5.
          const config: EngineConfig = {
            apiKey: API_KEY,
            projectId: PROJECT_ID,
            concurrency: 3,
            maxRetries: 2,
            targets: DEFAULT_TARGETS,
          };

          // Run in background (don't await)
          engine.start(credentials, config).catch((err) => {
            broadcast({
              type: "error",
              data: { message: `Engine crashed: ${err.message}` },
            });
          });
          break;
        }

        case "stop": {
          engine.stop();
          break;
        }

        case "refresh-csv": {
          cachedCredentials = engine.loadCredentials(CSV_PATH);
          const creds = cachedCredentials;
          ws.send(
            JSON.stringify({
              type: "credentials",
              data: { credentials: creds.map((c) => ({ email: c.email })) },
            })
          );
          break;
        }

        default:
          ws.send(JSON.stringify({ type: "error", data: { message: `Unknown message type: ${msg.type}` } }));
      }
    } catch (e: any) {
      ws.send(JSON.stringify({ type: "error", data: { message: e.message } }));
    }
  });

  ws.on("close", () => {
    console.log("[Server] Client disconnected");
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  const w = 52;
  const pad = (s: string) => s + " ".repeat(Math.max(0, w - s.length));
  console.log("");
  console.log("╔" + "═".repeat(w) + "╗");
  console.log("║" + pad("  DUAL-TARGET VALIDATOR — GUI SERVER") + "║");
  console.log("╠" + "═".repeat(w) + "╣");
  console.log("║" + pad(`  Dashboard:  http://localhost:${PORT}`) + "║");
  console.log("║" + pad(`  API Key:    ${API_KEY ? "✓ Set" : "✗ Missing"}`) + "║");
  console.log("║" + pad(`  Project:    ${PROJECT_ID ? "✓ Set" : "✗ Missing"}`) + "║");
  console.log("╚" + "═".repeat(w) + "╝");
  console.log("");
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function gracefulShutdown(signal: string): void {
  console.log(`\n[Server] ${signal} received — shutting down gracefully...`);
  if (engine.isRunning) {
    engine.stop();
    // Give active sessions up to 10s to finish
    const timeout = setTimeout(() => {
      console.log("[Server] Forced exit after 10s timeout");
      process.exit(1);
    }, 10000);
    engine.once("complete", () => {
      clearTimeout(timeout);
      console.log("[Server] Engine drained — exiting cleanly");
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
