"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/server.ts
require("dotenv/config");
const http_1 = __importDefault(require("http"));
const ws_1 = __importDefault(require("ws"));
const { WebSocketServer } = ws_1.default;
const app_1 = require("./app");
const env_1 = require("./config/env");
const bell_scheduler_1 = require("./modules/bells/bell.scheduler");
const radio_scheduler_1 = require("./modules/radio/radio.scheduler");
const SyncEngine_1 = require("./sync/SyncEngine");
const users_admin_routes_1 = __importDefault(require("./modules/users/users.admin.routes"));
// ── HTTP szerver (Express app becsomagolva) ───────────────────────────────────
const server = http_1.default.createServer(app_1.app);
// ── WebSocket szerver (ugyanazon a porton, /sync path) ───────────────────────
const wss = new WebSocketServer({
    server,
    path: "/sync",
    // Maximális payload 64KB – elegendő a szinkron üzenetekhez
    maxPayload: 64 * 1024,
});
// SyncEngine inicializálás
SyncEngine_1.SyncEngine.init(wss);
// ── Schedulers ────────────────────────────────────────────────────────────────
(0, bell_scheduler_1.startBellsScheduler)();
(0, radio_scheduler_1.startRadioScheduler)();
app_1.app.use("/admin/users", users_admin_routes_1.default);
// ── Indítás ───────────────────────────────────────────────────────────────────
server.listen(env_1.env.PORT, () => {
    console.log(`[Server] 🚀 API listening on port ${env_1.env.PORT}`);
    console.log(`[Server] 🔌 WebSocket ready on ws://localhost:${env_1.env.PORT}/sync`);
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
