// src/modules/cluster/tenant-ownership.ts
//
// Minden node-on fut. Periodikusan lekérdezi, mely tenantok vannak jelenleg
// EHHEZ a node-hoz rendelve (Tenant.assignedNodeId), és egy in-memory
// Set-ben tartja – ez a "kié ez a tenant" egyetlen forrása mind a WS accept
// (SyncEngine), mind a HTTP ownership-check (requireTenant), mind a
// SnapcastServiceClass.getEngine() számára.
//
// Aktiválás (tenant megjelenik a Setben) NEM igényel semmilyen explicit
// lépést – a SnapcastServiceClass.getEngine() már ma is lusta (csak első
// tényleges használatkor inicializál egy tenant snapserverét), tehát elég
// ha a node egyszerűen nem utasítja vissza a saját tenantjait.
//
// Deaktiválás (tenant eltűnik a Setből – elvesztettük a rebalancing miatt)
// VISZONT explicit teardown-t igényel: a már csatlakozott kliensek WS
// kapcsolatát azonnal le kell zárni (ne várjanak a köv. beacon/timeoutra),
// és a helyi Snapcast-folyamatot le kell állítani. Mindkettőt itt hívjuk
// meg, poll-diff alapján (WS lezárás ELŐBB, snap-teardown UTÁNA – ne
// maradjon egy pillanatra sem hang olyan klienseknek, akiket mindjárt
// kirúgunk).

import { prisma } from "../../prisma/client";
import { env } from "../../config/env";
import { getSelfNodeId } from "./cluster.heartbeat";

let _running = false;
let _owned = new Set<string>();

// Lazy import – elkerüli a körkörös import-függőséget induláskor
// (SyncEngine / SnapcastService importálhatja ezt a modult az ownership
// ellenőrzéshez, ez a modul pedig csak TEARDOWN-kor, futásidőben nyúl
// vissza hozzájuk).
async function deactivateLostTenant(tenantId: string, newHostname: string | null): Promise<void> {
  try {
    const { SyncEngine } = await import("../../sync/SyncEngine");
    SyncEngine.disconnectTenant(tenantId, newHostname);
  } catch (e) {
    console.error(`[TENANT-OWNERSHIP] SyncEngine.disconnectTenant hiba (${tenantId}):`, e);
  }

  try {
    const { SnapcastService } = await import("../snapcast/snapcast.service");
    await SnapcastService.deactivateTenant(tenantId);
  } catch (e) {
    console.error(`[TENANT-OWNERSHIP] SnapcastService.deactivateTenant hiba (${tenantId}):`, e);
  }

  console.log(`[TENANT-OWNERSHIP] tenant=${tenantId} deaktiválva (elköltözött${newHostname ? ` → ${newHostname}` : " – új node ismeretlen"})`);
}

export function isOwnedByThisNode(tenantId: string): boolean {
  return _owned.has(tenantId);
}

async function tick(): Promise<void> {
  const selfNodeId = getSelfNodeId();
  if (!selfNodeId) return;

  try {
    const rows = await prisma.tenant.findMany({
      where: { assignedNodeId: selfNodeId, isActive: true },
      select: { id: true },
    });
    const fresh = new Set(rows.map((r) => r.id));

    const lost: string[] = [];
    for (const id of _owned) {
      if (!fresh.has(id)) lost.push(id);
    }

    _owned = fresh;

    if (lost.length > 0) {
      // Batch lekérdezés: hova kerültek a "lost" tenantok – ez adja a
      // NODE_REASSIGNED üzenet célját (ld. terv Kör 2, C szakasz). Ha a
      // tenant épp erre a node-ra (megint) mutatna, vagy nincs (már)
      // hozzárendelve sehova, nem küldünk hostname-et – a kliens ilyenkor
      // a saját reconnect+discovery fallback-jára hagyatkozik.
      const moved = await prisma.tenant.findMany({
        where: { id: { in: lost } },
        select: { id: true, assignedNode: { select: { hostname: true } } },
      });
      const newHostBy = new Map(moved.map((t) => [t.id, t.assignedNode?.hostname ?? null]));

      for (const id of lost) {
        const h = newHostBy.get(id) ?? null;
        void deactivateLostTenant(id, h && h !== env.NODE_HOSTNAME ? h : null);
      }
    }
  } catch (e) {
    console.error("[TENANT-OWNERSHIP] tick hiba:", e);
  }
}

export function startOwnershipPoller(): void {
  if (_running) return;
  _running = true;
  console.log(`[TENANT-OWNERSHIP] Indult (tick: ${env.CLUSTER_OWNERSHIP_POLL_INTERVAL_MS}ms)`);
  void tick();
  setInterval(() => void tick(), env.CLUSTER_OWNERSHIP_POLL_INTERVAL_MS);
}
