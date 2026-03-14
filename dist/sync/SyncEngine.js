"use strict";
// src/sync/SyncEngine.ts
// ─────────────────────────────────────────────────────────────────────────────
//  SyncCast Protocol – kétfázisú szinkron lejátszás motor
//  Fázis 1: PREPARE  → eszközök prefetchelnek, READY ACK-ot küldenek
//  Fázis 2: PLAY     → abszolút UTC timestamp, mindenki egyszerre indul
// ─────────────────────────────────────────────────────────────────────────────
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SyncEngine = void 0;
const ws_1 = __importDefault(require("ws"));
const { WebSocketServer } = ws_1.default;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../config/env");
// ── SyncEngine ────────────────────────────────────────────────────────────────
class SyncEngineClass {
    wss = null;
    clients = new Map(); // deviceId → client
    pending = new Map(); // commandId → sync
    profiles = new Map(); // deviceId → profile
    // Konfig
    PREPARE_WINDOW_MS = 2000; // ennyi idő a prefetchre
    SAFETY_MARGIN_MS = 300; // playAt buffer a p95 felett
    FALLBACK_LEAD_MS = 2500; // ha nincs ACK sem, ennyi múlva játszik
    MIN_LEAD_MS = 800; // minimum lead time
    ACK_WAIT_MS = 1800; // ennyi ms-ig várunk ACK-okra
    // ── Init ──────────────────────────────────────────────────────────────────
    init(wss) {
        this.wss = wss;
        console.log("[SyncEngine] ✅ Inicializálva");
        wss.on("connection", (ws, req) => {
            this.handleConnection(ws, req);
        });
    }
    // ── WebSocket kapcsolat kezelése ──────────────────────────────────────────
    handleConnection(ws, req) {
        // JWT auth az URL query stringből: ws://api.../sync?token=xxx
        const url = new URL(req.url ?? "/", "http://localhost");
        const token = url.searchParams.get("token");
        if (!token) {
            ws.close(4001, "Missing token");
            return;
        }
        let payload;
        try {
            payload = jsonwebtoken_1.default.verify(token, env_1.env.JWT_ACCESS_SECRET);
        }
        catch {
            ws.close(4002, "Invalid token");
            return;
        }
        const deviceId = payload.deviceId ?? payload.sub ?? "unknown";
        const tenantId = payload.tenantId ?? payload.tid ?? "";
        if (!tenantId) {
            ws.close(4003, "Missing tenantId");
            return;
        }
        // Ha ugyanaz az eszköz újracsatlakozik, leváltja a régit
        const existing = this.clients.get(deviceId);
        if (existing && existing.ws.readyState === 1) {
            existing.ws.close(4010, "Replaced by new connection");
        }
        const client = {
            ws, deviceId, tenantId,
            type: payload.authType === "JWT" ? "browser" : "esp32",
            connectedAt: new Date(),
        };
        this.clients.set(deviceId, client);
        console.log(`[SyncEngine] 🔌 Csatlakozott: ${deviceId} (${client.type}) tenant=${tenantId}`);
        // Ping-pong keepalive
        const pingInterval = setInterval(() => {
            if (ws.readyState === 1) {
                ws.ping();
            }
            else {
                clearInterval(pingInterval);
            }
        }, 25_000);
        ws.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(deviceId, tenantId, msg);
            }
            catch (e) {
                console.warn(`[SyncEngine] Érvénytelen üzenet: ${deviceId}`, e);
            }
        });
        ws.on("close", () => {
            clearInterval(pingInterval);
            // Csak akkor töröljük ha ez a jelenlegi kapcsolat
            if (this.clients.get(deviceId)?.ws === ws) {
                this.clients.delete(deviceId);
                console.log(`[SyncEngine] 🔌 Lecsatlakozott: ${deviceId}`);
            }
        });
        ws.on("error", (err) => {
            console.error(`[SyncEngine] WS hiba: ${deviceId}`, err.message);
        });
        // Üdvözlő üzenet – időszinkronhoz
        this.send(ws, {
            type: "HELLO",
            serverNow: new Date().toISOString(),
            deviceId,
        });
    }
    // ── Beérkező üzenetek ─────────────────────────────────────────────────────
    handleMessage(deviceId, tenantId, msg) {
        if (msg.type === "READY_ACK") {
            this.receiveAck(msg);
        }
        else if (msg.type === "TIME_SYNC") {
            // Időszinkron kérés – válasz azonnali
            const client = this.clients.get(deviceId);
            if (client) {
                this.send(client.ws, {
                    type: "TIME_SYNC_RESPONSE",
                    clientSeq: msg.seq,
                    serverNow: new Date().toISOString(),
                });
            }
        }
    }
    // ── PREPARE broadcast ─────────────────────────────────────────────────────
    /**
     * Főmetódus: szinkron lejátszás indítása.
     * Meghívandó a schedulerből / message dispatcherből.
     */
    async dispatchSync(params) {
        const { tenantId, commandId, action, url, text, title, targetDeviceIds } = params;
        // Online eszközök szűrése
        const targets = this.getOnlineClients(tenantId, targetDeviceIds);
        if (targets.length === 0) {
            console.log(`[SyncEngine] ⚠️ Nincs online eszköz: tenant=${tenantId}`);
            return;
        }
        // Lead time kiszámítása az eszközprofilok alapján
        const leadMs = this.computeLeadTime(targets.map(c => c.deviceId));
        const deadline = new Date(Date.now() + this.PREPARE_WINDOW_MS);
        const syncState = {
            commandId, tenantId, action, url, text, title,
            prepareDeadline: deadline,
            acks: new Map(),
            expectedDevices: new Set(targets.map(c => c.deviceId)),
            playAtTimer: null,
            resolved: false,
        };
        this.pending.set(commandId, syncState);
        // PREPARE küldése
        const prepareMsg = {
            phase: "PREPARE",
            commandId,
            action,
            url,
            text,
            title,
            prepareDeadline: deadline.toISOString(),
        };
        console.log(`[SyncEngine] 📤 PREPARE → ${targets.length} eszköz, leadMs=${leadMs}, commandId=${commandId}`);
        for (const client of targets) {
            this.send(client.ws, prepareMsg);
        }
        // Fallback timer: ha nem jön minden ACK, playAt = most + leadMs
        syncState.playAtTimer = setTimeout(() => {
            if (!syncState.resolved) {
                console.log(`[SyncEngine] ⏱ ACK timeout – fallback PLAY: ${commandId}`);
                this.sendPlay(syncState, leadMs);
            }
        }, this.ACK_WAIT_MS);
    }
    // ── READY ACK fogadás ─────────────────────────────────────────────────────
    receiveAck(ack) {
        const { commandId, deviceId, bufferMs } = ack;
        const syncState = this.pending.get(commandId);
        if (!syncState || syncState.resolved)
            return;
        syncState.acks.set(deviceId, {
            commandId,
            deviceId,
            readyAt: ack.readyAt,
            bufferMs: bufferMs ?? 0,
        });
        // Profil frissítése
        this.updateProfile(deviceId, bufferMs ?? 0);
        console.log(`[SyncEngine] ✅ READY ACK: ${deviceId}, bufferMs=${bufferMs} (${syncState.acks.size}/${syncState.expectedDevices.size})`);
        // Ha mindenki ACK-olt → azonnal PLAY
        if (syncState.acks.size >= syncState.expectedDevices.size) {
            if (syncState.playAtTimer)
                clearTimeout(syncState.playAtTimer);
            const maxBufferMs = Math.max(...Array.from(syncState.acks.values()).map(a => a.bufferMs));
            const leadMs = Math.max(this.MIN_LEAD_MS, maxBufferMs + this.SAFETY_MARGIN_MS);
            console.log(`[SyncEngine] 🎯 Minden ACK megérkezett – PLAY leadMs=${leadMs}`);
            this.sendPlay(syncState, leadMs);
        }
    }
    // ── PLAY broadcast ────────────────────────────────────────────────────────
    sendPlay(syncState, leadMs) {
        if (syncState.resolved)
            return;
        syncState.resolved = true;
        const playAt = new Date(Date.now() + leadMs);
        const playMsg = {
            phase: "PLAY",
            commandId: syncState.commandId,
            playAt: playAt.toISOString(),
        };
        const targets = this.getOnlineClients(syncState.tenantId);
        console.log(`[SyncEngine] 🎵 PLAY → ${targets.length} eszköz, playAt=${playAt.toISOString()}`);
        for (const client of targets) {
            this.send(client.ws, playMsg);
        }
        // Cleanup
        setTimeout(() => this.pending.delete(syncState.commandId), 30_000);
    }
    // ── Broadcast (SYNC_BELLS, STOP stb. – azonnali, nem szinkronizált) ───────
    broadcastImmediate(tenantId, payload, targetDeviceIds) {
        const targets = this.getOnlineClients(tenantId, targetDeviceIds);
        for (const client of targets) {
            this.send(client.ws, payload);
        }
        console.log(`[SyncEngine] 📡 Broadcast → ${targets.length} eszköz`);
    }
    // ── Helpers ───────────────────────────────────────────────────────────────
    getOnlineClients(tenantId, deviceIds) {
        const result = [];
        for (const client of this.clients.values()) {
            if (client.tenantId !== tenantId)
                continue;
            if (client.ws.readyState !== 1)
                continue;
            if (deviceIds && !deviceIds.includes(client.deviceId))
                continue;
            result.push(client);
        }
        return result;
    }
    send(ws, payload) {
        if (ws.readyState === 1) {
            ws.send(JSON.stringify(payload));
        }
    }
    computeLeadTime(deviceIds) {
        const p95values = deviceIds.map(id => this.profiles.get(id)?.p95 ?? 600);
        const maxP95 = Math.max(...p95values);
        return Math.max(this.MIN_LEAD_MS, maxP95 + this.SAFETY_MARGIN_MS);
    }
    updateProfile(deviceId, bufferMs) {
        let profile = this.profiles.get(deviceId);
        if (!profile) {
            profile = { deviceId, samples: [], avg: bufferMs, p95: bufferMs };
            this.profiles.set(deviceId, profile);
        }
        profile.samples.push(bufferMs);
        if (profile.samples.length > 10)
            profile.samples.shift(); // csak utolsó 10
        const sorted = [...profile.samples].sort((a, b) => a - b);
        profile.avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
        profile.p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
    }
    // ── Publikus státusz ──────────────────────────────────────────────────────
    getStatus() {
        return {
            connectedClients: this.clients.size,
            pendingSyncs: this.pending.size,
            clients: Array.from(this.clients.values()).map(c => ({
                deviceId: c.deviceId,
                tenantId: c.tenantId,
                type: c.type,
                connectedAt: c.connectedAt,
            })),
        };
    }
    isDeviceOnline(deviceId) {
        const client = this.clients.get(deviceId);
        return !!client && client.ws.readyState === 1;
    }
}
// Singleton export
exports.SyncEngine = new SyncEngineClass();
