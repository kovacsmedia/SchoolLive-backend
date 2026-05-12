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

/** Aktívan csatlakozott kliensek listája.
 *
 * FONTOS: szándékosan kizárjuk a disconnected klienseket. A snapserver a
 * server.json-ban hosszú távon tárolja minden korábbi klienst (akár hetekkel
 * korábban csatlakozottakat is). Ha mindegyikre `Client.SetVolume`-ot küldünk,
 * az `applyTargetingToClients` egy TTS-re 30-100+ HTTP RPC-t generálhat a
 * helyi snapserver ControlServer-jére, ami:
 *  - sok 'Failed to shudown socket: system:107' errort okoz,
 *  - 600+ ms-ig terheli a snapserver eseménykezelőjét,
 *  - eközben a PipeStream reader szál nem olvas a FIFO-ból elég gyorsan,
 *  - a snapserver "No data since 120 ms, switching to idle" miatt idle-be megy,
 *  - idle->playing átmenetnél 300-500 ms-os onResync ugrás van,
 *  - amit a kliensek (ESP, Android, Linux) audible glitch-ként látnak a TTS elején.
 *
 * Csak a `connected: true` kliensekre szólunk - ezek azok, amelyek aktívan
 * fogyasztják a streamet és tényleg mute/unmute célzást igényelnek.
 */
export async function rpcListClients(httpPort: number): Promise<RpcClient[]> {
  const result = await rpcCall(httpPort, "Server.GetStatus");
  const groups: RpcGroup[] = result?.server?.groups ?? [];
  return groups
    .flatMap(g => g.clients ?? [])
    .filter(c => c.connected === true);
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

/** Minden klienst némítunk. */
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

/** Minden klienst teljes hangerőre állít (muted=false, volume=100).
 *  Szerver-újraindítás vagy deploy után szükséges, hogy a korábbi
 *  rpcMuteAll() által mentett mute állapotokat töröljük. */
export async function rpcUnmuteAll(httpPort: number, percent = 100): Promise<number> {
  let n = 0;
  try {
    const clients = await rpcListClients(httpPort);
    await Promise.allSettled(
      clients.map(c => rpcSetClientVolume(httpPort, c.id, percent, false).then(() => { n++; }))
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

/** Kliens végleges törlése a snapserver state-jéből.
 *  Akkor használjuk, amikor a backend Device lifecycle 48 óra offline után
 *  törli az eszközt - a snapserver server.json-jából is távolítsuk el,
 *  hogy a rpcListClients ne adja vissza zombi sessionökként.
 *  A snapserver "Server.DeleteClient" RPC-je némán is sikeres ha a kliens
 *  már nem létezik. */
export async function rpcDeleteClient(httpPort: number, clientId: string): Promise<boolean> {
  try {
    await rpcCall(httpPort, "Server.DeleteClient", { id: clientId });
    return true;
  } catch {
    return false;
  }
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
