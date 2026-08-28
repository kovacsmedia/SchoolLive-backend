// src/sync/SyncEngine.ts
import WS from "ws";
const { WebSocketServer } = WS;
type WebSocket = WS;
import type { IncomingMessage }        from "http";
import jwt                             from "jsonwebtoken";
import bcrypt                          from "bcrypt";
import { env }                         from "../config/env";

export type SyncAction = "BELL" | "TTS" | "PLAY_URL" | "STOP_PLAYBACK" | "SYNC_BELLS" | "OTA_UPDATE"
  // NOW_PLAYING_INFO: a backend audio mixer onSourceStart event-jéből megy ki,
  // hogy a kliens HUD pontosan az aktuálisan szóló forrás nevét/típusát mutassa
  // (különösen forrás-csere esetén, amikor a stream tovább megy).
  | "NOW_PLAYING_INFO";

export interface PreparePayload {
  phase:             "PREPARE";
  commandId:         string;
  action:            SyncAction;
  url?:              string;
  text?:             string;
  title?:            string;
  // Megjelenítési kategória az eszközök UI-ján: "MESSAGE" | "RADIO" | "SIGNAL" | "EMERGENCY"
  // Ha hiányzik, az eszköz az action-ből következtet.
  kind?:             string;
  prepareDeadline:   string;
  snapcastActive?:   boolean;
  // Fordított targeting: a snap stream alapból néma; csak az itt felsorolt
  // deviceId-k emelik fel a hangerőt. Ha üres / hiányzik → senki nem szól.
  // Minden online tenant-kliensnek megy a payload (broadcast), így ha valaki
  // nem értesül, alapból csendben marad.
  unmutedDeviceIds?: string[];
  // A pontos lejátszási idő már a PREPARE-ben benne van, hogy a kliens
  // pre-bufferelhessen és pontos sleep-et indíthasson.
  playAtMs?:         number;
  durationMs?:       number;
}

export interface PlayPayload {
  phase:             "PLAY";
  commandId:         string;
  playAt:            string;
  playAtMs?:         number;
  durationMs?:       number;
  unmutedDeviceIds?: string[];
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
  // A tényleges Device.id az adatbázisban. ESP32/native (deviceKey-auth)
  // kliensnél megegyezik a `deviceId`-vel. Böngésző (JWT-auth) kliensnél a
  // `deviceId` a kliens saját localStorage clientId-ja, ami NEM a Device.id –
  // ezt itt tároljuk, hogy a DB-írások (beacon, online-státusz, parancs
  // lookup) mindig a helyes rekordot érjék el.
  dbDeviceId:  string;
  tenantId:    string;
  type:        "browser" | "esp32";
  connectedAt: Date;
  ipAddress:   string | null;
}

interface PendingSync {
  commandId:        string;
  tenantId:         string;
  action:           SyncAction;
  url?:             string;
  text?:            string;
  title?:           string;
  prepareDeadline:  Date;
  acks:             Map<string, ReadyAck>;
  expectedDevices:  Set<string>;       // ACK-ot ezektől várjuk (a célzott set)
  unmutedDeviceIds: string[];          // payload mezőhöz
  playAtTimer:      ReturnType<typeof setTimeout> | null;
  resolved:         boolean;
  fixedPlayAtMs?:   number;
  durationMs?:      number;
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

  // Multizone: zóna device ID → master device ID leképezés.
  // Ha egy zóna ID bármely dispatch-ben célzott, a master kapja az üzenetet.
  private zoneToMaster: Map<string, string> = new Map();

  private readonly PREPARE_WINDOW_MS = 1500;
  private readonly SAFETY_MARGIN_MS  = 300;
  private readonly MIN_LEAD_MS       = 1200;
  private readonly ACK_WAIT_MS       = 600;

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

    // Multi-node cluster: ez a tenant lehet, hogy NEM ehhez a node-hoz van
    // rendelve (rebalancing miatt elköltözött, vagy a kliens még a régi
    // node-ot próbálja). A 4009-es close code szándékosan egyedi – a
    // majdani kliens-oldali reconnect-logika ebből tudja, hogy más node-ot
    // kell keresnie (GET /cluster/locate), nem általános auth-hiba.
    const { isOwnedByThisNode } = await import("../modules/cluster/tenant-ownership");
    if (!isOwnedByThisNode(tenantId)) {
      ws.close(4009, "Tenant not hosted on this node");
      return;
    }

    const existing = this.clients.get(deviceId);
    if (existing && existing.ws.readyState === 1) existing.ws.close(4010, "Replaced");

    const ipAddress =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      (req.socket as any)?.remoteAddress ||
      null;

    // dbDeviceId egyelőre = deviceId (esp32-nél ez már helyes); böngészőnél
    // lentebb, a userId+tenantId lookup után frissül a tényleges Device.id-re.
    const client: ConnectedClient = { ws, deviceId, dbDeviceId: deviceId, tenantId, type: clientType, connectedAt: new Date(), ipAddress };
    this.clients.set(deviceId, client);
    console.log(`[SyncEngine] 🔌 Csatlakozott: ${deviceId} (${client.type}) tenant=${tenantId}`);

    // Holt kapcsolat felismerése: ha egy klienstől 70mp-ig (kb. 2-3 ping
    // ciklus) nem jön pong, a socket félig-nyitva ragadhatott (pl. kliens
    // oldali hálózati hiba, ami nem zárja le tisztán a TCP-t) – ilyenkor
    // online-nak látszana a poll/HTTP kivezetése után is, hiszen kizárólag
    // erre a WS-kapcsolatra támaszkodunk. terminate() erőltetett zárás,
    // ami lefuttatja a meglévő "close" handlert (offline jelölés, cleanup).
    let lastPongAt = Date.now();
    ws.on("pong", () => { lastPongAt = Date.now(); });
    const pingInterval = setInterval(() => {
      if (ws.readyState !== 1) { clearInterval(pingInterval); return; }
      if (Date.now() - lastPongAt > 70_000) {
        console.warn(`[SyncEngine] ⚠️ Nincs pong 70mp-ig, holt kapcsolat bontása: ${deviceId}`);
        clearInterval(pingInterval);
        ws.terminate();
        return;
      }
      ws.ping();
    }, 25_000);

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      try { this.handleMessage(deviceId, tenantId, JSON.parse(data.toString())); }
      catch (e) { console.warn(`[SyncEngine] Érvénytelen üzenet: ${deviceId}`, e); }
    });

    ws.on("close", () => {
      clearInterval(pingInterval);
      const closing = this.clients.get(deviceId);
      if (closing?.ws === ws) {
        this.clients.delete(deviceId);
        console.log(`[SyncEngine] 🔌 Lecsatlakozott: ${deviceId}`);
        void this.onDeviceDisconnected(deviceId, closing.dbDeviceId);
      }
    });

    ws.on("error", (err: Error) => console.error(`[SyncEngine] WS hiba: ${deviceId}`, err.message));

    const nowMs = Date.now();

    // HELLO payload bővítve: a kliens által megkövetelt syncOffsetMs is megy
    // ki, hogy a snapclient sync-jét csatlakozáskor azonnal alkalmazni tudja
    // (újraindítás nélkül). A futás közbeni változást a SET_SYNC_OFFSET
    // action push-olja.
    //
    // ESP32: deviceId = Device.id (deviceKey-ből feloldva)
    // Browser (PLAYER user): deviceId = clientId (localStorage UUID), de a
    //   tényleges Device.id-t userId+tenantId-ből kell feloldani; a webplayer
    //   ezt használja a snap-HELLO ID mezőjéhez.
    let syncOffsetMs = 0;
    let resolvedSnapDeviceId: string | null = null;
    let snapHost: string | null = null;
    let snapPort: number | null = null;
    if (tenantId) {
      try {
        const { prisma } = await import("../prisma/client");
        if (clientType === "esp32") {
          const [dev, tenant] = await Promise.all([
            prisma.device.findUnique({ where: { id: deviceId }, select: { syncOffsetMs: true } }),
            prisma.tenant.findUnique({ where: { id: tenantId }, select: { snapPort: true } }),
          ]);
          if (dev) syncOffsetMs = dev.syncOffsetMs ?? 0;
          resolvedSnapDeviceId = deviceId;
          snapHost = env.NODE_HOSTNAME; // multi-node: mindig EZ a node a snap-cél, sosem egy globális fix host (ld. terv Fázis 7)
          snapPort = tenant?.snapPort ?? null;
        } else if (token) {
          // Browser: a JWT-ben benne van a userId (payload.sub).
          // A Device-t userId+tenantId párral oldjuk fel (egy player-user-hez
          // egy browser-device, lásd player.device.controller register).
          const decoded = jwt.decode(token) as any;
          const userIdFromToken: string | undefined = decoded?.sub;
          if (userIdFromToken) {
            const dev = await prisma.device.findFirst({
              where: { userId: userIdFromToken, tenantId },
              select: { id: true, syncOffsetMs: true },
            });
            if (dev) {
              resolvedSnapDeviceId = dev.id;
              syncOffsetMs = dev.syncOffsetMs ?? 0;
            }
          }
        }
      } catch (e) {
        console.warn(`[SyncEngine] HELLO lookup hiba (${deviceId}):`, e);
      }
    }

    // A regisztrált klienshez tartozó dbDeviceId frissítése a feloldott
    // Device.id-re (böngészőnél ez tér el a `deviceId` regisztrációs kulcstól).
    client.dbDeviceId = resolvedSnapDeviceId ?? deviceId;

    this.send(ws, {
      type:           "HELLO",
      serverNow:      new Date(nowMs).toISOString(),
      serverNowMs:    nowMs,
      deviceId,
      // snapDeviceId: a Device.id, amit a webplayer a snap-HELLO ID mezőjéhez
      // használ. ESP32-nél azonos a deviceId-vel; browser-nél a clientId
      // (localStorage UUID) helyett a tényleges Device.id, amit a snapserver
      // a targeting (rpcSetClientVolume) során lát.
      snapDeviceId:   resolvedSnapDeviceId ?? deviceId,
      syncOffsetMs,
      // ESP32-nek azonnal elérhető a Snapcast konfig – nincs szükség külön beacon HTTP hívásra
      ...(clientType === "esp32" && snapHost && snapPort ? { snapHost, snapPort } : {}),
    });

    void this.onDeviceConnected(deviceId, client.dbDeviceId, tenantId, clientType, ipAddress);
  }

  private handleMessage(deviceId: string, tenantId: string, msg: any): void {
    const client     = this.clients.get(deviceId);
    const dbDeviceId = client?.dbDeviceId ?? deviceId;
    if (msg.type === "READY_ACK") {
      this.receiveAck(msg as ReadyAck & { type: string });
    } else if (msg.type === "TIME_SYNC") {
      if (client) this.send(client.ws, { type: "TIME_SYNC_RESPONSE", clientSeq: msg.seq, serverNow: new Date().toISOString() });
    } else if (msg.type === "BEACON") {
      void this.handleBeacon(deviceId, dbDeviceId, tenantId, msg);
    } else if (msg.type === "CMD_ACK") {
      void this.handleCmdAck(deviceId, dbDeviceId, tenantId, msg);
    }
  }

  async dispatchSync(params: {
    tenantId:         string;
    commandId:        string;
    action:           SyncAction;
    url?:             string;
    text?:            string;
    title?:           string;
    /** Megjelenítési kategória az eszközök UI-ján: "MESSAGE" | "RADIO" | "SIGNAL" | "EMERGENCY"
     *  Ha nincs megadva, az eszköz az action-ből következtet (pl. "BELL" → "SIGNAL"). */
    kind?:            string;
    /** Fordított targeting: ezek az eszközök kapnak hangot. A snap stream
     *  alapból néma; ők lesznek unmutálva. Üres → senki sem szól.
     *  Minden online tenant-kliensnek megy a PREPARE (broadcast), de ACK-ot
     *  csak ettől a halmaztól várunk. */
    targetDeviceIds?: string[];
    snapcastActive?:  boolean;
    playAtMs?:        number;
    durationMs?:      number;
  }): Promise<void> {
    const { tenantId, commandId, action, url, text, title, kind,
            targetDeviceIds, snapcastActive, playAtMs, durationMs } = params;

    // Broadcast: minden online kliens értesül – ha nem szerepel az
    // unmutedDeviceIds-ben, "tudja" hogy csendben kell maradnia.
    const allOnline = this.getOnlineClients(tenantId);
    if (allOnline.length === 0) {
      console.log(`[SyncEngine] ⚠️ Nincs online eszköz: tenant=${tenantId}`);
      return;
    }

    const unmutedSet = new Set(targetDeviceIds && targetDeviceIds.length > 0
      ? targetDeviceIds
      : allOnline.map(c => c.deviceId));   // ha nincs szűkítés → mindenki

    // ACK-ot csak az unmutált (célzott) klienesektől várunk – a többi nem
    // is csinál semmit, tőlük nem kell ack.
    const expected = allOnline
      .filter(c => unmutedSet.has(c.deviceId))
      .map(c => c.deviceId);

    const leadMs   = this.computeLeadTime(expected.length > 0 ? expected : allOnline.map(c => c.deviceId));
    const deadline = new Date(Date.now() + this.PREPARE_WINDOW_MS);
    const unmutedDeviceIds = Array.from(unmutedSet);

    const syncState: PendingSync = {
      commandId, tenantId, action, url, text, title,
      prepareDeadline:  deadline,
      acks:             new Map(),
      expectedDevices:  new Set(expected),
      unmutedDeviceIds,
      playAtTimer:      null,
      resolved:         false,
      fixedPlayAtMs:    playAtMs,
      durationMs,
    };
    this.pending.set(commandId, syncState);

    const prepareMsg: PreparePayload = {
      phase:             "PREPARE",
      commandId,
      action,
      url, text, title,
      ...(kind ? { kind } : {}),
      prepareDeadline:   deadline.toISOString(),
      snapcastActive,
      unmutedDeviceIds,
      playAtMs,
      durationMs,
    };

    console.log(`[SyncEngine] 📤 PREPARE broadcast → ${allOnline.length} kliens (unmuted: ${unmutedDeviceIds.length}, ackTól: ${expected.length}) cmd=${commandId}${durationMs ? ` dur=${durationMs}ms` : ""}`);
    for (const client of allOnline) this.send(client.ws, prepareMsg);

    // Ha senkitől nem várunk ACK-ot (pl. célzott kliens nincs online), azonnal lőjük a PLAY-t.
    if (expected.length === 0) {
      this.sendPlay(syncState, leadMs);
      return;
    }

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
      phase:             "PLAY",
      commandId:         syncState.commandId,
      playAt:            playAt.toISOString(),
      playAtMs:          playAt.getTime(),
      durationMs:        syncState.durationMs,
      unmutedDeviceIds:  syncState.unmutedDeviceIds,
    };

    const targets = this.getOnlineClients(syncState.tenantId);
    console.log(`[SyncEngine] 🎵 PLAY broadcast → ${targets.length} kliens, playAt=${playAt.toISOString()}${syncState.durationMs ? ` dur=${syncState.durationMs}ms` : ""}`);
    for (const client of targets) this.send(client.ws, playMsg);

    setTimeout(() => this.pending.delete(syncState.commandId), 30_000);
  }

  broadcastImmediate(tenantId: string, payload: object, targetDeviceIds?: string[]): void {
    const targets = this.getOnlineClients(tenantId, targetDeviceIds);
    for (const client of targets) this.send(client.ws, payload);
    console.log(`[SyncEngine] 📡 Broadcast → ${targets.length} eszköz`);
  }

  // Tenant-független broadcast – kizárólag a FirmwareRelease-hez kell, mivel
  // az globális (nincs tenantId mezője), minden bejelentkezett eszköznek
  // szól. A device-osztály/verzió szerinti tényleges szűrést a kliens saját
  // GET /firmware/check hívása végzi el – ez a broadcast csak egy "nézd meg
  // most" ébresztő, nem a frissítés maga.
  broadcastToAllTenants(payload: object): void {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.ws.readyState !== 1) continue;
      this.send(client.ws, payload);
      count++;
    }
    console.log(`[SyncEngine] 📡 Globális broadcast → ${count} eszköz`);
  }

  // Multi-node cluster: amikor ez a node elveszít egy tenantot (rebalancing
  // miatt), az annak kapcsolódott kliensei ne várjanak a köv. beacon/ping-
  // timeoutra – azonnal, explicit lezárjuk a WS kapcsolatukat, ugyanazzal
  // a 4009 close code-dal, mint a handleConnection() ownership-kapuja.
  // A tenant-ownership.ts poll-diff-je hívja, mielőtt a snap-engine teardown
  // is lefut.
  // `newHostname`: ha meg van adva, MINDEN érintett klienshez elküldünk egy
  // explicit "ide menj" üzenetet a close előtt, hogy azonnal, aktívan tudjon
  // átkapcsolni – nem kell megvárnia a saját reconnect+discovery fallback-ját.
  // Csak élő régi tulajdonos node hívja (halott node-on nem fut semmi, ami
  // hívhatná – ld. tenant-ownership.ts).
  disconnectTenant(tenantId: string, newHostname?: string | null): void {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.tenantId !== tenantId) continue;
      if (client.ws.readyState === 1) {
        if (newHostname) this.send(client.ws, { type: "NODE_REASSIGNED", hostname: newHostname });
        client.ws.close(4009, "Tenant not hosted on this node");
      }
      count++;
    }
    if (count > 0) console.log(`[SyncEngine] 🔌 disconnectTenant(${tenantId}): ${count} kliens lezárva${newHostname ? ` → ${newHostname}` : ""}`);
  }

  private getOnlineClients(tenantId: string, deviceIds?: string[]): ConnectedClient[] {
    const result: ConnectedClient[] = [];
    const seen = new Set<string>();
    for (const client of this.clients.values()) {
      if (client.tenantId !== tenantId) continue;
      if (client.ws.readyState !== 1) continue;
      if (deviceIds) {
        // Közvetlen egyezés VAGY zóna ID-ként a master ez az eszköz
        const directMatch = deviceIds.includes(client.deviceId);
        const zoneMatch   = deviceIds.some(id => this.zoneToMaster.get(id) === client.deviceId);
        if (!directMatch && !zoneMatch) continue;
      }
      if (!seen.has(client.deviceId)) {
        seen.add(client.deviceId);
        result.push(client);
      }
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

  // `deviceId` = WS regisztrációs kulcs (this.clients keye, socket-lookuphoz).
  // `dbDeviceId` = a tényleges Device.id (DB-írásokhoz/-lookupokhoz). ESP32-nél
  // a kettő egyezik; böngészőnél a `deviceId` a kliens clientId-ja, a
  // `dbDeviceId` a userId+tenantId alapján feloldott valódi Device.id.
  private async onDeviceConnected(
    deviceId: string,
    dbDeviceId: string,
    tenantId: string,
    clientType: "browser" | "esp32",
    ipAddress: string | null,
  ): Promise<void> {
    let channelMode = "MIXED";
    let zones: Array<{ zoneIndex: number; deviceId: string }> = [];
    try {
      const { prisma } = await import("../prisma/client");
      const dev = await prisma.device.update({
        where: { id: dbDeviceId },
        data: { online: true, lastSeenAt: new Date(), ipAddress: ipAddress ?? undefined },
        select: { channelMode: true, deviceClass: true },
      });
      channelMode = dev?.channelMode ?? "MIXED";

      // Multizone: betöltjük a zóna device ID-ket és feltöltjük a zónatérképet
      if (dev?.deviceClass === "MULTIZONE") {
        const zoneDevices = await prisma.device.findMany({
          where: { parentDeviceId: dbDeviceId },
          select: { id: true, zoneIndex: true },
          orderBy: { zoneIndex: "asc" },
        });
        // Z1 (master) is a zone
        zones = [{ zoneIndex: 1, deviceId: dbDeviceId }, ...zoneDevices.map(z => ({ zoneIndex: z.zoneIndex ?? 0, deviceId: z.id }))];
        for (const z of zoneDevices) {
          this.zoneToMaster.set(z.id, dbDeviceId);
        }
        console.log(`[SyncEngine] MULTIZONE zónatérkép: ${dbDeviceId} → ${zoneDevices.length + 1} zóna`);
        // Zóna eszközök online-nak jelölése
        await prisma.device.updateMany({
          where: { parentDeviceId: dbDeviceId },
          data: { online: true, lastSeenAt: new Date() },
        });
      }
    } catch (e) {
      console.warn(`[SyncEngine] onDeviceConnected DB hiba (${dbDeviceId}):`, e);
    }

    const client = this.clients.get(deviceId);
    if (!client || client.ws.readyState !== 1) return;

    // SCHEDULE_SYNC MINDEN kliens-típusnak megy (nem csak ESP32-nek) – a
    // teljes tanévnyi naptárat (ld. buildFullYearCalendar) is tartalmazza,
    // hogy bármelyik platform el tudja tárolni/hasznosítani, ne csak a
    // "ma" nézetet lássa.
    try {
      const { buildScheduleSyncPayload } = await import("../modules/bells/bells.routes");
      const payload = await buildScheduleSyncPayload(tenantId);
      this.send(client.ws, payload);
      console.log(`[SyncEngine] 📅 SCHEDULE_SYNC → ${deviceId}`);
    } catch (e) {
      console.warn(`[SyncEngine] SCHEDULE_SYNC hiba (${deviceId}):`, e);
    }

    if (clientType !== "esp32") return;

    // channelMode szinkronizálás
    if (channelMode !== "MIXED" && client?.ws.readyState === 1) {
      this.send(client.ws, {
        type: "COMMAND",
        commandId: `ch-init-${deviceId}`,
        payload: { action: "SET_CHANNEL_MODE", mode: channelMode },
      });
    }

    // Multizone: zóna device ID-k küldése az ESP32-nek
    if (zones.length > 0 && client?.ws.readyState === 1) {
      this.send(client.ws, { type: "ZONE_CONFIG", zones });
      console.log(`[SyncEngine] 🔌 ZONE_CONFIG → ${deviceId}: ${zones.length} zóna`);
    }

    await this.pushPendingCommands(deviceId, dbDeviceId, tenantId);
  }

  private async onDeviceDisconnected(deviceId: string, dbDeviceId: string): Promise<void> {
    // Zónatérkép tisztítása
    for (const [zoneId, masterId] of this.zoneToMaster.entries()) {
      if (masterId === dbDeviceId) this.zoneToMaster.delete(zoneId);
    }
    try {
      const { prisma } = await import("../prisma/client");
      await prisma.device.update({ where: { id: dbDeviceId }, data: { online: false } });
      // Multizone: zóna eszközök offline-nak jelölése
      await prisma.device.updateMany({ where: { parentDeviceId: dbDeviceId }, data: { online: false } });
    } catch (e) {
      console.warn(`[SyncEngine] onDeviceDisconnected DB hiba (${dbDeviceId}):`, e);
    }
  }

  private async handleBeacon(deviceId: string, dbDeviceId: string, tenantId: string, msg: any): Promise<void> {
    const { volume, muted, firmwareVersion, statusPayload } = msg;
    try {
      const { prisma } = await import("../prisma/client");
      await prisma.device.update({
        where: { id: dbDeviceId },
        data: {
          online:          true,
          lastSeenAt:      new Date(),
          firmwareVersion: typeof firmwareVersion === "string" ? firmwareVersion : undefined,
          volume:          typeof volume === "number" ? volume : undefined,
          muted:           typeof muted === "boolean" ? muted : undefined,
          statusPayload:   statusPayload ?? undefined,
        },
      });

      const tenant = await prisma.tenant.findUnique({
        where:  { id: tenantId },
        select: { snapPort: true },
      });
      const snapHost = env.NODE_HOSTNAME; // multi-node: mindig EZ a node a snap-cél, sosem egy globális fix host (ld. terv Fázis 7)

      const client = this.clients.get(deviceId);
      if (client?.ws.readyState === 1) {
        this.send(client.ws, {
          type:     "BEACON_ACK",
          snapHost,
          snapPort: tenant?.snapPort ?? null,
        });
      }
    } catch (e) {
      console.error(`[SyncEngine] handleBeacon hiba (${dbDeviceId}):`, e);
    }
  }

  private async handleCmdAck(deviceId: string, dbDeviceId: string, tenantId: string, msg: any): Promise<void> {
    const { commandId, ok, error } = msg;
    if (!commandId || typeof commandId !== "string") return;
    try {
      const { prisma } = await import("../prisma/client");
      const cmd = await prisma.deviceCommand.findFirst({
        where: { id: commandId, tenantId, deviceId: dbDeviceId },
      });
      if (!cmd || cmd.status === "ACKED" || cmd.status === "FAILED") return;
      await prisma.deviceCommand.update({
        where: { id: cmd.id },
        data: {
          status:  ok ? "ACKED" : "FAILED",
          ackedAt: new Date(),
          error:   typeof error === "string" ? error : null,
        },
      });
      console.log(`[SyncEngine] ✅ CMD_ACK: ${commandId} ok=${ok} device=${dbDeviceId}`);
      await this.pushPendingCommands(deviceId, dbDeviceId, tenantId);
    } catch (e) {
      console.error(`[SyncEngine] handleCmdAck hiba (${dbDeviceId}):`, e);
    }
  }

  async pushPendingCommands(deviceId: string, dbDeviceId: string, tenantId: string): Promise<void> {
    const client = this.clients.get(deviceId);
    if (!client || client.ws.readyState !== 1) return;
    try {
      const { prisma } = await import("../prisma/client");

      const queued = await prisma.deviceCommand.findFirst({
        where:   { deviceId: dbDeviceId, tenantId, status: "QUEUED" },
        orderBy: { queuedAt: "asc" },
      });
      if (!queued) return;

      const updated = await prisma.deviceCommand.updateMany({
        where: { id: queued.id, status: "QUEUED" },
        data:  { status: "SENT", sentAt: new Date() },
      });
      if (updated.count === 0) return;

      this.send(client.ws, {
        type:      "COMMAND",
        commandId: queued.id,
        payload:   queued.payload,
      });
      console.log(`[SyncEngine] 📤 COMMAND push → ${deviceId}: ${(queued.payload as any)?.action}`);
    } catch (e) {
      console.error(`[SyncEngine] pushPendingCommands hiba (${deviceId}):`, e);
    }
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
    // A hívók (bells/messages/radio ütemezők) mindig a valódi Device.id-t
    // adják át. ESP32/native kliensnél ez egyezik a WS regisztrációs
    // kulccsal, így a direkt lookup elég. Böngészőnél (WebPlayer) a
    // regisztrációs kulcs a kliens saját clientId-ja – ott dbDeviceId
    // alapján kell megkeresni a klienst.
    const client = this.clients.get(deviceId);
    if (client && client.ws.readyState === 1) return true;
    for (const c of this.clients.values()) {
      if (c.dbDeviceId === deviceId && c.ws.readyState === 1) return true;
    }
    // Zóna device: a master online státusza alapján
    const masterId = this.zoneToMaster.get(deviceId);
    if (masterId) {
      const master = this.clients.get(masterId);
      return !!master && master.ws.readyState === 1;
    }
    return false;
  }
}

export const SyncEngine = new SyncEngineClass();