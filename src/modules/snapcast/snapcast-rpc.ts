// src/modules/snapcast/snapcast-rpc.ts
//
// Vékony JSON-RPC kliens a tenant-szintű snapserverhez.
// HTTP POST /jsonrpc → snapcast methods.
//
// Használjuk:
//   • Server.GetStatus     – kliens lista (státuszhoz, mappinghoz)
//   • Client.SetVolume     – per-kliens mute / volume vezérlés
//
// A "fordított targeting" alapja: minden klienst némítva tartunk; csak a
// célzott eszközök volume-ja megy 100% / muted=false a lejátszás idejére.

import http from "http";

interface RpcVolume { muted: boolean; percent: number; }
interface RpcClient {
  id:       string;
  connected: boolean;
  host:     { name: string; mac: string; ip: string; os?: string; arch?: string };
  config:   { name: string; volume: RpcVolume; instance?: number };
  lastSeen?: { sec: number; usec: number };
}
interface RpcGroup { id: string; name: string; muted: boolean; stream_id: string; clients: RpcClient[]; }
interface RpcServerStatus {
  result?: { server: { groups: RpcGroup[]; server: { snapserver: { version: string } } } };
  error?:  { code: number; message: string };
}

const RPC_TIMEOUT_MS = 1500;

let _seq = 0;
function nextId(): number { return ++_seq; }

async function rpcCall(httpPort: number, method: string, params?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ id: nextId(), jsonrpc: "2.0", method, ...(params ? { params } : {}) });
    const req  = http.request({
      hostname: "127.0.0.1",
      port:     httpPort,
      path:     "/jsonrpc",
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout:  RPC_TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          const txt  = Buffer.concat(chunks).toString();
          const json = JSON.parse(txt);
          if (json.error) return reject(new Error(`${method}: ${json.error.code} ${json.error.message}`));
          resolve(json.result);
        } catch (e: any) { reject(new Error(`${method} parse: ${e.message}`)); }
      });
    });
    req.on("timeout", () => { req.destroy(new Error(`${method} timeout`)); });
    req.on("error",   (e) => reject(e));
    req.write(body);
    req.end();
  });
}

/** Snapserver elérhető-e? */
export async function rpcPing(httpPort: number): Promise<boolean> {
  try { await rpcCall(httpPort, "Server.GetStatus"); return true; }
  catch { return false; }
}

/** Összes kliens listája. */
export async function rpcListClients(httpPort: number): Promise<RpcClient[]> {
  const result = await rpcCall(httpPort, "Server.GetStatus");
  const groups: RpcGroup[] = result?.server?.groups ?? [];
  return groups.flatMap(g => g.clients ?? []);
}

/** Egy kliens hangerő/mute beállítása. */
export async function rpcSetClientVolume(
  httpPort: number, clientId: string, percent: number, muted: boolean
): Promise<void> {
  await rpcCall(httpPort, "Client.SetVolume", {
    id: clientId,
    volume: { muted, percent: Math.max(0, Math.min(100, Math.round(percent))) },
  });
}

/** Minden klienst némítunk (default állapot). */
export async function rpcMuteAll(httpPort: number, percent = 0): Promise<number> {
  let n = 0;
  try {
    const clients = await rpcListClients(httpPort);
    await Promise.allSettled(
      clients.map(c => rpcSetClientVolume(httpPort, c.id, percent, true).then(() => { n++; }))
    );
  } catch (e) { /* swallow */ }
  return n;
}

/** Megadott kliensek unmute-olva 100%-on, a többi marad muted. */
export async function rpcSetUnmutedSet(
  httpPort: number,
  unmutedClientIds: string[],
  unmutedPercent = 100,
  mutedPercent   = 0,
): Promise<{ unmuted: number; muted: number }> {
  const set = new Set(unmutedClientIds);
  let unmuted = 0, muted = 0;
  try {
    const clients = await rpcListClients(httpPort);
    await Promise.allSettled(clients.map(c => {
      if (set.has(c.id) || set.has(c.config.name) || set.has(c.host.name)) {
        return rpcSetClientVolume(httpPort, c.id, unmutedPercent, false).then(() => { unmuted++; });
      }
      return rpcSetClientVolume(httpPort, c.id, mutedPercent, true).then(() => { muted++; });
    }));
  } catch (e) { /* swallow */ }
  return { unmuted, muted };
}

/** Egy snapclient megfeleltetése egy device.id-nak: id, config.name, host.name
 *  bármelyikében lehet a deviceId; visszaadjuk a snapClient.id-t.  */
export async function rpcResolveClientIdsForDevices(
  httpPort: number,
  deviceIds: string[],
): Promise<string[]> {
  try {
    const clients = await rpcListClients(httpPort);
    const wanted  = new Set(deviceIds);
    return clients
      .filter(c => wanted.has(c.id) || wanted.has(c.config?.name ?? "") || wanted.has(c.host?.name ?? ""))
      .map(c => c.id);
  } catch { return []; }
}
