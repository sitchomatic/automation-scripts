/**
 * GUI SERVER
 * Express + WebSocket server that serves the dashboard frontend
 * and relays real-time automation events.
 */

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

  // Send initial state
  const credentials = engine.loadCredentials(CSV_PATH);
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
                data: { message: "Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID. Set them in run.bat." },
              })
            );
            return;
          }

          const credentials = engine.loadCredentials(CSV_PATH);
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
          const creds = engine.loadCredentials(CSV_PATH);
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
  console.log("");
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║       DUAL-TARGET VALIDATOR — GUI SERVER            ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  Dashboard:  http://localhost:${PORT}                  ║`);
  console.log(`║  API Key:    ${API_KEY ? "✓ Set" : "✗ Missing"}                             ║`);
  console.log(`║  Project:    ${PROJECT_ID ? "✓ Set" : "✗ Missing"}                             ║`);
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log("");
});
