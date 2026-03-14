// src/server.ts
import "dotenv/config";
import http from "http";
import WS from "ws";
const { WebSocketServer } = WS;
type WebSocket = WS;

import { app }                  from "./app";
import { env }                  from "./config/env";
import { startBellsScheduler }  from "./modules/bells/bell.scheduler";
import { startRadioScheduler }  from "./modules/radio/radio.scheduler";
import { SyncEngine }           from "./sync/SyncEngine";
import usersAdminRoutes         from "./modules/users/users.admin.routes";

// ── HTTP szerver (Express app becsomagolva) ───────────────────────────────────
const server = http.createServer(app);

// ── WebSocket szerver (ugyanazon a porton, /sync path) ───────────────────────
const wss = new WebSocketServer({
  server,
  path: "/sync",
  // Maximális payload 64KB – elegendő a szinkron üzenetekhez
  maxPayload: 64 * 1024,
});

// SyncEngine inicializálás
SyncEngine.init(wss);

// ── Schedulers ────────────────────────────────────────────────────────────────
startBellsScheduler();
startRadioScheduler();

app.use("/admin/users", usersAdminRoutes);

// ── Indítás ───────────────────────────────────────────────────────────────────
server.listen(env.PORT, () => {
  console.log(`[Server] 🚀 API listening on port ${env.PORT}`);
  console.log(`[Server] 🔌 WebSocket ready on ws://localhost:${env.PORT}/sync`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on("SIGTERM", () => {
  console.log("[Server] SIGTERM – leállítás...");
  wss.close(() => {
    server.close(() => {
      console.log("[Server] Leállítva.");
      process.exit(0);
    });
  });
});