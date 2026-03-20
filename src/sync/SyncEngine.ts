// src/sync/SyncEngine.ts
// ─────────────────────────────────────────────────────────────────────────────
//  SyncCast Protocol – kétfázisú szinkron lejátszás motor
//  Fázis 1: PREPARE  → eszközök prefetchelnek, READY ACK-ot küldenek
//  Fázis 2: PLAY     → abszolút UTC timestamp, mindenki egyszerre indul
// ─────────────────────────────────────────────────────────────────────────────

import WS from "ws";
const { WebSocketServer } = WS;
type WebSocket = WS;
import type { IncomingMessage }        from "http";
import jwt                             from "jsonwebtoken";
import { createHash }                  from "crypto";
import bcrypt                          from "bcrypt";
import { env }                         from "../config/env";

// ── Típusok ──────────────────────────────────────────────────────────────────

export type SyncAction = "BELL" | "TTS" | "PLAY_URL" | "STOP_PLAYBACK" | "SYNC_BELLS" | "OTA_UPDATE";

export interface PreparePayload {
  phase:           "PREPARE";
  commandId:       string;
  action:          SyncAction;
  url?:            string;
  text?:           string;
  title?:          string;
  prepareDeadline: string;   // ISO – ennyi időd van a prefetchre
  snapcastActive?: boolean;
}

export interface PlayPayload {
  phase:     "PLAY";
  commandId: string;
  playAt:    string;         // ISO
  playAtMs?: number;         // Unix ms – ESP32 közvetlenül használja
}

export interface ReadyAck {
  commandId: string;
  deviceId:  string;
  readyAt:   string;
  bufferMs:  number;
}

interface ConnectedClient {
  ws:       WebSocket;
  deviceId: string;
  tenantId: string;
  type:     "browser" | "esp32";          // ESP32 is csatlakozhat WS-en ha akar
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
  acks:            Map<string, ReadyAck>; // deviceId → ack
  expectedDevices: Set<string>;           // kik kapták a PREPARE-t
  playAtTimer:     ReturnType<typeof setTimeout> | null;
  resolved:        boolean;
}

// ── Adaptive device profile ───────────────────────────────────────────────────

interface DeviceProfile {
  deviceId:        string;
  samples:         number[];  // utolsó 10 prepare idő (ms)
  avg:             number;
  p95:             number;
}

// ── SyncEngine ────────────────────────────────────────────────────────────────

class SyncEngineClass {
  private wss:      InstanceType<typeof WebSocketServer> | null = null;
  private clients:  Map<string, ConnectedClient> = new Map(); // deviceId → client
  private pending:  Map<string, PendingSync>     = new Map(); // commandId → sync
  private profiles: Map<string, DeviceProfile>   = new Map(); // deviceId → profile

  // Konfig
  private readonly PREPARE_WINDOW_MS  = 4000;  // ennyi idő a prefetchre
  private readonly SAFETY_MARGIN_MS   = 500;   // playAt buffer a p95 felett
  private readonly FALLBACK_LEAD_MS   = 5000;  // ha nincs minden ACK: 5s múlva játszik
  private readonly MIN_LEAD_MS        = 2000;  // minimum lead time (ESP32 startup ~350ms + margin)
  private readonly ACK_WAIT_MS        = 3800;  // ennyi ms-ig várunk ACK-okra

  // ── Init ──────────────────────────────────────────────────────────────────

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

  // ── WebSocket kapcsolat kezelése ──────────────────────────────────────────

  private async handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    // JWT auth az URL query stringből: ws://api.../sync?token=xxx
    const url    = new URL(req.url ?? "/", "http://localhost");
    const token  = url.searchParams.get("token");

    let deviceId = "unknown";
    let tenantId  = "";
    let clientType: "browser" | "esp32" = "browser";

    // JWT auth (browser VirtualPlayer)
    if (token) {
      let payload: any;
      try {
        payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
      } catch {
        ws.close(4002, "Invalid token");
        return;
      }
      deviceId   = payload.deviceId ?? payload.sub ?? "unknown";
      tenantId   = payload.tenantId ?? payload.tid ?? "";
      clientType = "browser";
    }

    // Ha sem token sem deviceKey → elutasítás
    const deviceKey = url.searchParams.get("deviceKey");
    if (!token && !deviceKey) {
      ws.close(4001, "Missing auth");
      return;
    }

    // Device key auth (ESP32) – deviceKeyHash = bcrypt(deviceKey)
    if (deviceKey && !token) {
      try {
        const { prisma } = await import("../prisma/client");
        // bcrypt: az összes eszközt le kell kérni majd compare-elni
        // (bcrypt nem kereshető direktben, de az eszközök száma kicsi)
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
        if (!matched) {
          console.warn("[SyncEngine] Ismeretlen device key (bcrypt)");
          ws.close(4004, "Invalid device key");
          return;
        }
        deviceId   = matched.id;
        tenantId   = matched.tenantId;
        clientType = "esp32";
        console.log(`[SyncEngine] ESP32 auth OK: ${deviceId} tenant=${tenantId}`);
      } catch (e) {
        console.error("[SyncEngine] Device key lookup hiba:", e);
        ws.close(4005, "Auth error");
        return;
      }
    }

    if (!tenantId) {
      ws.close(4003, "Missing tenantId");
      return;
    }

    // Ha ugyanaz az eszköz újracsatlakozik, leváltja a régit
    const existing = this.clients.get(deviceId);
    if (existing && existing.ws.readyState === 1) {
      existing.ws.close(4010, "Replaced by new connection");
    }

    const client: ConnectedClient = {
      ws, deviceId, tenantId,
      type: clientType,
      connectedAt: new Date(),
    };
    this.clients.set(deviceId, client);

    console.log(`[SyncEngine] 🔌 Csatlakozott: ${deviceId} (${client.type}) tenant=${tenantId}`);

    // Ping-pong keepalive
    const pingInterval = setInterval(() => {
      if (ws.readyState === 1) {
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 25_000);

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(deviceId, tenantId, msg);
      } catch (e) {
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

    ws.on("error", (err: Error) => {
      console.error(`[SyncEngine] WS hiba: ${deviceId}`, err.message);
    });

    // Üdvözlő üzenet – időszinkronhoz
    const nowMs = Date.now();
    this.send(ws, {
      type:        "HELLO",
      serverNow:   new Date(nowMs).toISOString(),
      serverNowMs: nowMs,   // numerikus ms – ESP32 közvetlenül használja
      deviceId,
    });
  }

  // ── Beérkező üzenetek ─────────────────────────────────────────────────────

  private handleMessage(deviceId: string, tenantId: string, msg: any): void {
    if (msg.type === "READY_ACK") {
      this.receiveAck(msg as ReadyAck & { type: string });
    } else if (msg.type === "TIME_SYNC") {
      // Időszinkron kérés – válasz azonnali
      const client = this.clients.get(deviceId);
      if (client) {
        this.send(client.ws, {
          type:      "TIME_SYNC_RESPONSE",
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
  async dispatchSync(params: {
    tenantId:    string;
    commandId:   string;
    action:      SyncAction;
    url?:        string;
    text?:       string;
    title?:      string;
    targetDeviceIds?: string[];  // ha null → tenant összes online eszköze
  }): Promise<void> {
    const { tenantId, commandId, action, url, text, title, targetDeviceIds } = params;

    // Online eszközök szűrése
    const targets = this.getOnlineClients(tenantId, targetDeviceIds);

    if (targets.length === 0) {
      console.log(`[SyncEngine] ⚠️ Nincs online eszköz: tenant=${tenantId}`);
      return;
    }

    // Lead time kiszámítása az eszközprofilok alapján
    const leadMs    = this.computeLeadTime(targets.map(c => c.deviceId));
    const deadline  = new Date(Date.now() + this.PREPARE_WINDOW_MS);

    const syncState: PendingSync = {
      commandId, tenantId, action, url, text, title,
      prepareDeadline: deadline,
      acks:            new Map(),
      expectedDevices: new Set(targets.map(c => c.deviceId)),
      playAtTimer:     null,
      resolved:        false,
    };
    this.pending.set(commandId, syncState);

    // PREPARE küldése
    const prepareMsg: PreparePayload = {
      phase:           "PREPARE",
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

  private receiveAck(ack: ReadyAck & { type: string }): void {
    const { commandId, deviceId, bufferMs } = ack;
    const syncState = this.pending.get(commandId);

    if (!syncState || syncState.resolved) return;

    syncState.acks.set(deviceId, {
      commandId,
      deviceId,
      readyAt:  ack.readyAt,
      bufferMs: bufferMs ?? 0,
    });

    // Profil frissítése
    this.updateProfile(deviceId, bufferMs ?? 0);

    console.log(`[SyncEngine] ✅ READY ACK: ${deviceId}, bufferMs=${bufferMs} (${syncState.acks.size}/${syncState.expectedDevices.size})`);

    // Ha mindenki ACK-olt → azonnal PLAY
    if (syncState.acks.size >= syncState.expectedDevices.size) {
      if (syncState.playAtTimer) clearTimeout(syncState.playAtTimer);

      // JAVÍTÁS: a bufferMs a LETÖLTÉSI idő – az már KÉSZ.
      // A playFile() startup overhead-et az ESP32 maga kompenzálja (SyncClient.cpp).
      // Elég MIN_LEAD_MS (2000ms) a PLAY broadcast propagációjához + biztonságra.
      // Ez kisebb lead time-ot eredményez mint a korábbi maxBufferMs + margin,
      // ami feleslegesen nagy késleltetést okozott.
      const leadMs = this.MIN_LEAD_MS;

      console.log(`[SyncEngine] 🎯 Minden ACK megérkezett (${syncState.acks.size} db) – PLAY leadMs=${leadMs}`);
      this.sendPlay(syncState, leadMs);
    }
  }

  // ── PLAY broadcast ────────────────────────────────────────────────────────

  private sendPlay(syncState: PendingSync, leadMs: number): void {
    if (syncState.resolved) return;
    syncState.resolved = true;

    const playAt = new Date(Date.now() + leadMs);
    const playMsg: PlayPayload = {
      phase:      "PLAY",
      commandId:  syncState.commandId,
      playAt:     playAt.toISOString(),
      playAtMs:   playAt.getTime(),   // numerikus ms – ESP32 közvetlenül használja
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

  broadcastImmediate(tenantId: string, payload: object, targetDeviceIds?: string[]): void {
    const targets = this.getOnlineClients(tenantId, targetDeviceIds);
    for (const client of targets) {
      this.send(client.ws, payload);
    }
    console.log(`[SyncEngine] 📡 Broadcast → ${targets.length} eszköz`);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

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
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
  }

  private computeLeadTime(deviceIds: string[]): number {
    const p95values = deviceIds.map(id => this.profiles.get(id)?.p95 ?? 600);
    const maxP95    = Math.max(...p95values);
    return Math.max(this.MIN_LEAD_MS, maxP95 + this.SAFETY_MARGIN_MS);
  }

  private updateProfile(deviceId: string, bufferMs: number): void {
    let profile = this.profiles.get(deviceId);
    if (!profile) {
      profile = { deviceId, samples: [], avg: bufferMs, p95: bufferMs };
      this.profiles.set(deviceId, profile);
    }

    profile.samples.push(bufferMs);
    if (profile.samples.length > 10) profile.samples.shift(); // csak utolsó 10

    const sorted = [...profile.samples].sort((a, b) => a - b);
    profile.avg  = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    profile.p95  = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
  }

  // ── Publikus státusz ──────────────────────────────────────────────────────

  getStatus(): object {
    return {
      connectedClients: this.clients.size,
      pendingSyncs:     this.pending.size,
      clients: Array.from(this.clients.values()).map(c => ({
        deviceId: c.deviceId,
        tenantId: c.tenantId,
        type:     c.type,
        connectedAt: c.connectedAt,
      })),
    };
  }

  isDeviceOnline(deviceId: string): boolean {
    const client = this.clients.get(deviceId);
    return !!client && client.ws.readyState === 1;
  }
}

// Singleton export
export const SyncEngine = new SyncEngineClass();