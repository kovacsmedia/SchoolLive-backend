// src/sync/SyncEngine.ts
import WS from "ws";
const { WebSocketServer } = WS;
type WebSocket = WS;
import type { IncomingMessage }        from "http";
import jwt                             from "jsonwebtoken";
import bcrypt                          from "bcrypt";
import { env }                         from "../config/env";

export type SyncAction = "BELL" | "TTS" | "PLAY_URL" | "STOP_PLAYBACK" | "SYNC_BELLS" | "OTA_UPDATE";

export interface PreparePayload {
  phase:           "PREPARE";
  commandId:       string;
  action:          SyncAction;
  url?:            string;
  text?:           string;
  title?:          string;
  prepareDeadline: string;
  snapcastActive?: boolean;
}

export interface PlayPayload {
  phase:       "PLAY";
  commandId:   string;
  playAt:      string;
  playAtMs?:   number;
  durationMs?: number;   // lejátszás hossza ms-ben – overlay timer-hez
}

export interface ReadyAck {
  commandId: string;
  deviceId:  string;
  readyAt:   string;
  bufferMs:  number;
}

interface ConnectedClient {
  ws:          WebSocket;
  deviceId:    string;
  tenantId:    string;
  type:        "browser" | "esp32";
  connectedAt: Date;
}

interface PendingSync {
  commandId:       string;
  tenantId:        string;
  action:          SyncAction;
  url?:            string;
  text?:           string;
  title?:          string;
  prepareDeadline: Date;
  acks:            Map<string, ReadyAck>;
  expectedDevices: Set<string>;
  playAtTimer:     ReturnType<typeof setTimeout> | null;
  resolved:        boolean;
  fixedPlayAtMs?:  number;
  durationMs?:     number;
}

interface DeviceProfile {
  deviceId: string;
  samples:  number[];
  avg:      number;
  p95:      number;
}

class SyncEngineClass {
  private wss:      InstanceType<typeof WebSocketServer> | null = null;
  private clients:  Map<string, ConnectedClient> = new Map();
  private pending:  Map<string, PendingSync>     = new Map();
  private profiles: Map<string, DeviceProfile>   = new Map();

  private readonly PREPARE_WINDOW_MS = 4000;
  private readonly SAFETY_MARGIN_MS  = 500;
  private readonly MIN_LEAD_MS       = 2000;
  private readonly ACK_WAIT_MS       = 3800;

  init(wss: InstanceType<typeof WebSocketServer>): void {
    this.wss = wss;
    console.log("[SyncEngine] ✅ Inicializálva");
    wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req).catch(err => {
        console.error("[SyncEngine] handleConnection hiba:", err);
        try { ws.close(4500, "Internal error"); } catch {}
      });
    });
  }

  private async handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const url       = new URL(req.url ?? "/", "http://localhost");
    const token     = url.searchParams.get("token");
    const deviceKey = url.searchParams.get("deviceKey");

    let deviceId   = "unknown";
    let tenantId   = "";
    let clientType: "browser" | "esp32" = "browser";

    if (token) {
      let payload: any;
      try { payload = jwt.verify(token, env.JWT_ACCESS_SECRET); }
      catch { ws.close(4002, "Invalid token"); return; }
      deviceId   = url.searchParams.get("clientId") ?? payload.deviceId ?? payload.sub ?? "unknown";
      tenantId   = payload.tenantId ?? payload.tid ?? "";
      clientType = "browser";
    }

    if (!token && !deviceKey) { ws.close(4001, "Missing auth"); return; }

    if (deviceKey && !token) {
      try {
        const { prisma } = await import("../prisma/client");
        const devices = await prisma.device.findMany({
          where:  { deviceKeyHash: { not: null } },
          select: { id: true, tenantId: true, deviceKeyHash: true },
        });
        let matched: { id: string; tenantId: string } | null = null;
        for (const d of devices) {
          if (!d.deviceKeyHash) continue;
          const ok = await bcrypt.compare(deviceKey, d.deviceKeyHash);
          if (ok) { matched = d; break; }
        }
        if (!matched) { ws.close(4004, "Invalid device key"); return; }
        deviceId = matched.id; tenantId = matched.tenantId; clientType = "esp32";
        console.log(`[SyncEngine] ESP32 auth OK: ${deviceId} tenant=${tenantId}`);
      } catch (e) {
        console.error("[SyncEngine] Device key lookup hiba:", e);
        ws.close(4005, "Auth error"); return;
      }
    }

    if (!tenantId) { ws.close(4003, "Missing tenantId"); return; }

    const existing = this.clients.get(deviceId);
    if (existing && existing.ws.readyState === 1) existing.ws.close(4010, "Replaced");

    const client: ConnectedClient = { ws, deviceId, tenantId, type: clientType, connectedAt: new Date() };
    this.clients.set(deviceId, client);
    console.log(`[SyncEngine] 🔌 Csatlakozott: ${deviceId} (${client.type}) tenant=${tenantId}`);

    const pingInterval = setInterval(() => {
      if (ws.readyState === 1) ws.ping(); else clearInterval(pingInterval);
    }, 25_000);

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      try { this.handleMessage(deviceId, tenantId, JSON.parse(data.toString())); }
      catch (e) { console.warn(`[SyncEngine] Érvénytelen üzenet: ${deviceId}`, e); }
    });

    ws.on("close", () => {
      clearInterval(pingInterval);
      if (this.clients.get(deviceId)?.ws === ws) {
        this.clients.delete(deviceId);
        console.log(`[SyncEngine] 🔌 Lecsatlakozott: ${deviceId}`);
      }
    });

    ws.on("error", (err: Error) => console.error(`[SyncEngine] WS hiba: ${deviceId}`, err.message));

    const nowMs = Date.now();
    this.send(ws, { type: "HELLO", serverNow: new Date(nowMs).toISOString(), serverNowMs: nowMs, deviceId });
  }

  private handleMessage(deviceId: string, tenantId: string, msg: any): void {
    if (msg.type === "READY_ACK") {
      this.receiveAck(msg as ReadyAck & { type: string });
    } else if (msg.type === "TIME_SYNC") {
      const client = this.clients.get(deviceId);
      if (client) this.send(client.ws, { type: "TIME_SYNC_RESPONSE", clientSeq: msg.seq, serverNow: new Date().toISOString() });
    }
  }

  async dispatchSync(params: {
    tenantId:         string;
    commandId:        string;
    action:           SyncAction;
    url?:             string;
    text?:            string;
    title?:           string;
    targetDeviceIds?: string[];
    snapcastActive?:  boolean;
    playAtMs?:        number;
    durationMs?:      number;   // ← lejátszás hossza, overlay timer-hez
  }): Promise<void> {
    const { tenantId, commandId, action, url, text, title,
            targetDeviceIds, snapcastActive, playAtMs, durationMs } = params;

    const targets = this.getOnlineClients(tenantId, targetDeviceIds);
    if (targets.length === 0) {
      console.log(`[SyncEngine] ⚠️ Nincs online eszköz: tenant=${tenantId}`);
      return;
    }

    const leadMs   = this.computeLeadTime(targets.map(c => c.deviceId));
    const deadline = new Date(Date.now() + this.PREPARE_WINDOW_MS);

    const syncState: PendingSync = {
      commandId, tenantId, action, url, text, title,
      prepareDeadline: deadline,
      acks:            new Map(),
      expectedDevices: new Set(targets.map(c => c.deviceId)),
      playAtTimer:     null,
      resolved:        false,
      fixedPlayAtMs:   playAtMs,
      durationMs,
    };
    this.pending.set(commandId, syncState);

    const prepareMsg: PreparePayload = {
      phase: "PREPARE", commandId, action, url, text, title,
      prepareDeadline: deadline.toISOString(),
      snapcastActive,
    };

    console.log(`[SyncEngine] 📤 PREPARE → ${targets.length} eszköz, commandId=${commandId}${durationMs ? ` dur=${durationMs}ms` : ""}`);
    for (const client of targets) this.send(client.ws, prepareMsg);

    syncState.playAtTimer = setTimeout(() => {
      if (!syncState.resolved) {
        console.log(`[SyncEngine] ⏱ ACK timeout – fallback PLAY: ${commandId}`);
        this.sendPlay(syncState, leadMs);
      }
    }, this.ACK_WAIT_MS);
  }

  private receiveAck(ack: ReadyAck & { type: string }): void {
    const { commandId, deviceId, bufferMs } = ack;
    const syncState = this.pending.get(commandId);
    if (!syncState || syncState.resolved) return;

    syncState.acks.set(deviceId, { commandId, deviceId, readyAt: ack.readyAt, bufferMs: bufferMs ?? 0 });
    this.updateProfile(deviceId, bufferMs ?? 0);

    console.log(`[SyncEngine] ✅ READY ACK: ${deviceId}, bufferMs=${bufferMs} (${syncState.acks.size}/${syncState.expectedDevices.size})`);

    if (syncState.acks.size >= syncState.expectedDevices.size) {
      if (syncState.playAtTimer) clearTimeout(syncState.playAtTimer);
      this.sendPlay(syncState, this.MIN_LEAD_MS);
    }
  }

  private sendPlay(syncState: PendingSync, leadMs: number): void {
    if (syncState.resolved) return;
    syncState.resolved = true;

    const playAt = syncState.fixedPlayAtMs
      ? new Date(syncState.fixedPlayAtMs)
      : new Date(Date.now() + leadMs);

    if (syncState.fixedPlayAtMs && syncState.fixedPlayAtMs < Date.now() - 5000) {
      console.warn(`[SyncEngine] ⚠️ fixedPlayAtMs elmúlt – skip: ${syncState.commandId}`);
      this.pending.delete(syncState.commandId);
      return;
    }

    const playMsg: PlayPayload = {
      phase:      "PLAY",
      commandId:  syncState.commandId,
      playAt:     playAt.toISOString(),
      playAtMs:   playAt.getTime(),
      durationMs: syncState.durationMs,
    };

    const targets = this.getOnlineClients(syncState.tenantId);
    console.log(`[SyncEngine] 🎵 PLAY → ${targets.length} eszköz, playAt=${playAt.toISOString()}${syncState.durationMs ? ` dur=${syncState.durationMs}ms` : ""}`);
    for (const client of targets) this.send(client.ws, playMsg);

    setTimeout(() => this.pending.delete(syncState.commandId), 30_000);
  }

  broadcastImmediate(tenantId: string, payload: object, targetDeviceIds?: string[]): void {
    const targets = this.getOnlineClients(tenantId, targetDeviceIds);
    for (const client of targets) this.send(client.ws, payload);
    console.log(`[SyncEngine] 📡 Broadcast → ${targets.length} eszköz`);
  }

  private getOnlineClients(tenantId: string, deviceIds?: string[]): ConnectedClient[] {
    const result: ConnectedClient[] = [];
    for (const client of this.clients.values()) {
      if (client.tenantId !== tenantId) continue;
      if (client.ws.readyState !== 1) continue;
      if (deviceIds && !deviceIds.includes(client.deviceId)) continue;
      result.push(client);
    }
    return result;
  }

  private send(ws: WebSocket, payload: object): void {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  }

  private computeLeadTime(deviceIds: string[]): number {
    const p95values = deviceIds.map(id => this.profiles.get(id)?.p95 ?? 600);
    return Math.max(this.MIN_LEAD_MS, Math.max(...p95values) + this.SAFETY_MARGIN_MS);
  }

  private updateProfile(deviceId: string, bufferMs: number): void {
    let profile = this.profiles.get(deviceId);
    if (!profile) { profile = { deviceId, samples: [], avg: bufferMs, p95: bufferMs }; this.profiles.set(deviceId, profile); }
    profile.samples.push(bufferMs);
    if (profile.samples.length > 10) profile.samples.shift();
    const sorted = [...profile.samples].sort((a, b) => a - b);
    profile.avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    profile.p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
  }

  getStatus(): object {
    return {
      connectedClients: this.clients.size,
      pendingSyncs:     this.pending.size,
      clients: Array.from(this.clients.values()).map(c => ({
        deviceId: c.deviceId, tenantId: c.tenantId, type: c.type, connectedAt: c.connectedAt,
      })),
    };
  }

  isDeviceOnline(deviceId: string): boolean {
    const client = this.clients.get(deviceId);
    return !!client && client.ws.readyState === 1;
  }
}

export const SyncEngine = new SyncEngineClass();