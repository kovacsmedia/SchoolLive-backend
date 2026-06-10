// src/server.ts
import "dotenv/config";
import http from "http";
import WS from "ws";
const { WebSocketServer } = WS;

import { app }                  from "./app";
import { env }                  from "./config/env";
import { startBellsScheduler }  from "./modules/bells/bell.scheduler";
import { startRadioScheduler }  from "./modules/radio/radio.scheduler";
import { startDeviceLifecycleScheduler } from "./modules/devices/device.lifecycle";
import { SyncEngine }           from "./sync/SyncEngine";
import usersAdminRoutes         from "./modules/users/users.admin.routes";
import { createSnapStreamWss }  from "./modules/snapcast/snap-stream-proxy";

// ── HTTP szerver (Express app becsomagolva) ───────────────────────────────────
const server = http.createServer(app);

// ── WebSocket szerverek ───────────────────────────────────────────────────────
// Mindkét WSS `noServer:true`-vel jön létre, és egyetlen központi
// upgrade-dispatcher routol path szerint. Ha külön server+path WSS-eket
// használnánk párhuzamosan, a ws@8 az első nem-egyező WSS-nél `abortHandshake
// (400)` -t hív, és kilőné a másik útvonalat.
const syncWss = new WebSocketServer({
  noServer: true,
  // Maximális payload 64KB – elegendő a szinkron üzenetekhez
  maxPayload: 64 * 1024,
});
SyncEngine.init(syncWss);

const snapStreamWss = createSnapStreamWss();

server.on("upgrade", (req, socket, head) => {
  let pathname = "";
  try {
    pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    socket.destroy();
    return;
  }

  if (pathname === "/sync") {
    syncWss.handleUpgrade(req, socket, head, (ws) => {
      syncWss.emit("connection", ws, req);
    });
  } else if (pathname === "/snap-stream") {
    snapStreamWss.handleUpgrade(req, socket, head, (ws) => {
      snapStreamWss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ── Schedulers ────────────────────────────────────────────────────────────────
startBellsScheduler();
startRadioScheduler();
startDeviceLifecycleScheduler();

app.use("/admin/users", usersAdminRoutes);

// ── Indítás ───────────────────────────────────────────────────────────────────
server.listen(env.PORT, () => {
  console.log(`[Server] 🚀 API listening on port ${env.PORT}`);
  console.log(`[Server] 🔌 WebSocket ready: ws://localhost:${env.PORT}/sync`);
  console.log(`[Server] 🎧 Snap-stream WS ready: ws://localhost:${env.PORT}/snap-stream`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on("SIGTERM", () => {
  console.log("[Server] SIGTERM – leállítás...");
  syncWss.close(() => {
    snapStreamWss.close(() => {
      server.close(() => {
        console.log("[Server] Leállítva.");
        process.exit(0);
      });
    });
  });
});
