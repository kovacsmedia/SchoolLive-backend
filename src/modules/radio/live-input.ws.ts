// src/modules/radio/live-input.ws.ts
//
// ÉLŐ HANGBEMENET – WebSocket ingest.
//
// A böngésző (Iskolai Rádió → „Élő hangbemenet" fül) a gép alapértelmezett
// hangrögzítő eszközét (mikrofon, line-in, USB-hangkártya) veszi fel a
// MediaRecorder API-val, WebM/Opus darabokban, és ezen a csatornán küldi ide.
// Innen az adatfolyam a tenant mixerének ffmpeg-stdin-jére megy, onnan a
// szokásos úton: FIFO → snapserver → célzott lejátszók.
//
//   böngésző mikrofon/line-in
//        │  MediaRecorder (Opus ~96 kbps)
//        ▼
//   ──WS──► [live-input] ──stdin──► ffmpeg ──PCM──► mixer FIFO ──► snapserver
//
// MIÉRT OPUS: a lánc végén a snapserver is Opus-t sugároz a kliensek felé,
// és az iskolai feltöltési sávszélesség jellemzően szűk. A beszéd- és
// zeneminőség ~96 kbps-en már jó, ami töredéke egy tömörítetlen PCM-nek
// (1,4 Mbps). A böngésző natívan ezt tudja, tehát nincs extra átkódolás.
//
// KÉSLELTETÉS: a lánc minden eleme puffert tesz hozzá (felvevő-darabolás,
// hálózat, ffmpeg, FIFO, a snapserver ~1 mp-es kliens-puffere). Néhány
// másodperc – élő beszélgetés közvetítéséhez vagy analóg forrás digitalizálás
// nélküli lejátszásához bőven jó, oda-vissza beszélgetéshez nem.

import http from "http";
import crypto from "crypto";
import WS from "ws";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { prisma } from "../../prisma/client";
import { SnapcastService } from "../snapcast/snapcast.service";
import { SyncEngine } from "../../sync/SyncEngine";

/** Egy tenanton egyszerre egy élő bemenet lehet. */
const activeByTenant = new Map<string, WS>();

const CAN_WRITE = ["SUPER_ADMIN", "TENANT_ADMIN", "ORG_ADMIN"];

/**
 * `noServer:true` WSS, amit a `server.ts` központi upgrade-dispatcherje
 * a `/live-input` path-ra érkező kéréseknél `handleUpgrade()`-gel etet.
 */
export function createLiveInputWss(): InstanceType<typeof WS.WebSocketServer> {
  const wss = new WS.WebSocketServer({
    noServer: true,
    // Egy MediaRecorder-darab (200 ms @ ~96 kbps) pár kB. 1 MB bőven fedi a
    // nagyobb darabolást is, de megfogja a hibás/rosszindulatú küldőt.
    maxPayload: 1024 * 1024,
  });

  wss.on("connection", (ws: WS, req: http.IncomingMessage) => {
    void handleLiveInputConnection(ws, req);
  });

  return wss;
}

async function handleLiveInputConnection(ws: WS, req: http.IncomingMessage): Promise<void> {
  const url   = new URL(req.url ?? "/", "http://localhost");
  const token = url.searchParams.get("token") ?? "";

  if (!token) { ws.close(4001, "Missing token"); return; }

  let payload: any;
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
  } catch {
    ws.close(4002, "Invalid token");
    return;
  }

  const tenantId: string | undefined = payload.tenantId ?? payload.tid;
  const role:     string             = payload.role ?? "";
  if (!tenantId)            { ws.close(4003, "Missing tenantId"); return; }
  if (!CAN_WRITE.includes(role)) { ws.close(4004, "Forbidden"); return; }

  // Multi-node: ugyanaz a kapu, mint a snap-stream proxyn és a SyncEngine-en.
  // Egy nem-tulajdonos node mixerébe írni értelmetlen – ott nem is fut a
  // tenant snapservere.
  const { isOwnedByThisNode } = await import("../cluster/tenant-ownership");
  if (!isOwnedByThisNode(tenantId)) { ws.close(4009, "Tenant not hosted on this node"); return; }

  // Cél: mely eszközökön szóljon. Ugyanaz a séma, mint a rádió-lejátszásnál.
  const targetType = (url.searchParams.get("targetType") ?? "ALL").toUpperCase();
  const targetId   = url.searchParams.get("targetId") ?? "";
  const title      = (url.searchParams.get("title") ?? "").trim() || "Élő hangbemenet";

  // Kiszorítjuk az előző bemenetet (pl. újratöltött lap ottfelejtett WS-e).
  const prev = activeByTenant.get(tenantId);
  if (prev && prev !== ws) {
    try { prev.close(4008, "Replaced by a newer live input"); } catch { /* ignore */ }
  }
  activeByTenant.set(tenantId, ws);

  let deviceIds: string[];
  try {
    deviceIds = await resolveDeviceIds(tenantId, targetType, targetId);
  } catch (e: any) {
    console.error("[LIVE-INPUT] cél feloldása sikertelen:", e?.message);
    ws.close(4005, "Target resolution failed");
    return;
  }

  const snapOnline = await SnapcastService.isSnapserverOnline(tenantId);
  if (!snapOnline) {
    ws.send(JSON.stringify({ action: "error", error: "snapserver_offline" }));
    ws.close(4006, "Snapserver offline");
    activeByTenant.delete(tenantId);
    return;
  }

  /*
   * A felvevőt NEM most indítjuk el, hanem amikor a forrás tényleg aktív
   * lesz a mixerben. Az ffmpeg fejléccel kezdődő WebM-folyamot vár; ha a
   * böngésző már a pre-silence ablak alatt küldene, a fejléc egy olyan
   * ffmpeg-hez menne, ami még el sem indult. A `start` vezérlőüzenetet a
   * mixer `source:start` eseménye váltja ki – ez a csengetés utáni
   * folytatásnál is lefut, tehát a felvevő akkor is friss fejléccel indul.
   */
  const onControl = (msg: { action: "start" }) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  SnapcastService.registerLiveInputClient(tenantId, onControl);

  // Meglévő rádió/stream megszakítása – ugyanaz az „azonnal vált" élmény,
  // mint a netrádió ▶ gombjánál.
  await SnapcastService.stopRadio(tenantId);
  await SnapcastService.play({
    type:              "RADIO",
    source:            { type: "live" },
    tenantId,
    title,
    deviceIdsToUnmute: deviceIds,
    persistent:        true,
  });

  const onlineIds = deviceIds.filter(id => SyncEngine.isDeviceOnline(id));
  if (onlineIds.length > 0) {
    SyncEngine.dispatchSync({
      tenantId,
      commandId:       crypto.randomUUID(),
      action:          "PLAY_URL",
      kind:            "RADIO",
      // Élő bemenetnél nincs letölthető URL – a hang a snap streamen jön.
      // A kliensek ugyanúgy overlay-t mutatnak, mint netrádiónál.
      url:             "",
      title,
      targetDeviceIds: deviceIds,
      snapcastActive:  true,
    }).catch(e => console.error("[LIVE-INPUT] SyncEngine hiba:", e));
  }

  console.log(`[LIVE-INPUT] ▶ elindult: tenant=${tenantId}, cél=${targetType}, eszközök=${deviceIds.length}`);

  let bytes = 0;
  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (!isBinary) return;                     // vezérlés csak szerver → kliens
    const buf = toBuffer(data);
    if (buf.length === 0) return;
    bytes += buf.length;
    SnapcastService.writeLiveChunk(tenantId, buf);
  });

  const cleanup = async () => {
    SnapcastService.unregisterLiveInputClient(tenantId, onControl);
    if (activeByTenant.get(tenantId) === ws) {
      activeByTenant.delete(tenantId);
      /*
       * Csak akkor állítjuk le a rádiót, ha tényleg még élő bemenet van a
       * mixerben – közben indulhatott netrádió vagy ütemezett lejátszás, azt
       * nem szabad elvinnünk.
       *
       * `hasLiveSource` és NEM `isLiveInputActive`: ha a felhasználó az
       * indítás utáni egy másodpercen belül állítja le az adást, a forrás még
       * csak `pending`. A szűkebb kérdésre „nem" a válasz, a job viszont egy
       * pillanattal később aktívvá válna – egy már halott WebSocket mögött,
       * örökké élő ffmpeg-gel.
       */
      if (SnapcastService.hasLiveSource(tenantId)) {
        await SnapcastService.stopRadio(tenantId);
        SyncEngine.broadcastImmediate(tenantId, { action: "STOP_PLAYBACK" });
      }
    }
    console.log(`[LIVE-INPUT] ⏹ vége: tenant=${tenantId}, ${(bytes / 1024).toFixed(0)} kB`);
  };

  ws.on("close", () => { void cleanup(); });
  ws.on("error", (e) => {
    console.warn(`[LIVE-INPUT] WS hiba (${tenantId}): ${(e as any)?.message}`);
    void cleanup();
  });
}

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data))   return Buffer.concat(data);
  return Buffer.from(data);
}

async function resolveDeviceIds(
  tenantId: string,
  targetType: string,
  targetId: string
): Promise<string[]> {
  if (targetType === "DEVICE" && targetId) return [targetId];
  if (targetType === "GROUP" && targetId) {
    const members = await prisma.deviceGroupMember.findMany({
      where:  { groupId: targetId },
      select: { deviceId: true },
    });
    return members.map(m => m.deviceId);
  }
  const devices = await prisma.device.findMany({
    where:  { tenantId, online: true },
    select: { id: true },
  });
  return devices.map(d => d.id);
}
