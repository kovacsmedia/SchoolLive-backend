// src/modules/cluster/cluster.rebalancer.ts
//
// Csak a leaderen fut ténylegesen (isLeader() guard minden tick elején –
// a többi node-on a setInterval fut, de a tick azonnal visszatér).
//
// Algoritmus (egyszerű, darabszám-alapú – szándékos egyszerűsítés a
// jelenlegi méretnél, nem veszi figyelembe egy tenant tényleges terhelését):
//   1. Halott node-ok megjelölése (heartbeat-küszöb túllépés).
//   2. Árva tenantok (assignedNodeId null vagy halott node-ra mutat) →
//      AZONNAL, minden tickben, cooldown nélkül átkerülnek – ezek már
//      úgyis töröttek, itt a sürgősségé a prioritás.
//   3. Egyenletesség-pass: csak akkor mozgat tenantot PUSZTÁN egyenletesítés
//      miatt, ha egy node CLUSTER_REBALANCE_OVERLOAD_TICKS egymást követő
//      tick-en át folyamatosan túlterhelt volt (in-memory hiszterézis) –
//      lebegő node elleni védelem. Tickenként max 1 ilyen mozgatás.

import { prisma } from "../../prisma/client";
import { env } from "../../config/env";
import { isLeader } from "./cluster.leader";
import { notify } from "./cluster.alerts";
import { computeSafeTenantIds } from "./rebalance-safe-window";

let _running = false;

// In-memory hiszterézis-állapot – csak a leaderen releváns, leader-váltáskor
// elvész (elfogadott: legrosszabb esetben egy kicsit korai egyenletesítő
// mozgatás történik közvetlenül az új leader után, sosem helyességi hiba).
const _overloadStreak = new Map<string, number>();

type NodeRow = { id: string; hostname: string };
type TenantRow = { id: string; assignedNodeId: string | null };

async function markDeadNodes(): Promise<void> {
  const threshold = new Date(Date.now() - env.CLUSTER_NODE_DEAD_THRESHOLD_MS);
  const r = await prisma.clusterNode.updateMany({
    where: { status: "ACTIVE", lastHeartbeatAt: { lt: threshold } },
    data: { status: "DEAD" },
  });
  if (r.count > 0) {
    console.warn(`[CLUSTER-REBALANCER] ${r.count} node DEAD-nek jelölve (heartbeat >${env.CLUSTER_NODE_DEAD_THRESHOLD_MS}ms)`);
    void notify("nodes_marked_dead", { count: r.count });
  }
}

/**
 * A legkevésbé terhelt, kioszthatóra alkalmas (ACTIVE, nem DRAINING) node
 * kiválasztása. Exportált, mert a tenant-létrehozás route-ja (tenants.admin.routes.ts)
 * ezt hívja az induló kiosztáshoz, hogy egy vadonatúj tenant ne maradjon
 * kiosztatlanul a következő rebalance-tickig.
 */
export async function pickLeastLoadedNode(): Promise<NodeRow | null> {
  const activeNodes: NodeRow[] = await prisma.clusterNode.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, hostname: true },
    orderBy: { hostname: "asc" },
  });
  if (activeNodes.length === 0) return null;

  const counts = await prisma.tenant.groupBy({
    by: ["assignedNodeId"],
    where: { isActive: true, assignedNodeId: { in: activeNodes.map((n) => n.id) } },
    _count: { _all: true },
  });
  const countByNode = new Map(counts.map((c) => [c.assignedNodeId as string, c._count._all]));

  let best = activeNodes[0];
  let bestCount = countByNode.get(best.id) ?? 0;
  for (const n of activeNodes.slice(1)) {
    const c = countByNode.get(n.id) ?? 0;
    if (c < bestCount) { best = n; bestCount = c; }
  }
  return best;
}

async function reassignTenant(tenantId: string, toNodeId: string, reason: "orphan" | "rebalance"): Promise<void> {
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { assignedNodeId: toNodeId, assignedAt: new Date() },
  });
  console.log(`[CLUSTER-REBALANCER] tenant=${tenantId} → node=${toNodeId} (${reason})`);
}

async function tick(): Promise<void> {
  if (!isLeader()) return;

  try {
    await markDeadNodes();

    const activeNodes: NodeRow[] = await prisma.clusterNode.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, hostname: true },
      orderBy: { hostname: "asc" },
    });
    if (activeNodes.length === 0) {
      console.warn("[CLUSTER-REBALANCER] Nincs ACTIVE node – rebalancing kihagyva ebben a tickben");
      return;
    }
    const activeNodeIds = new Set(activeNodes.map((n) => n.id));

    const tenants: TenantRow[] = await prisma.tenant.findMany({
      where: { isActive: true },
      select: { id: true, assignedNodeId: true },
    });

    // ── 1) Árvák: null vagy halott/ismeretlen node-ra mutat → azonnal ──────
    const orphans = tenants.filter((t) => !t.assignedNodeId || !activeNodeIds.has(t.assignedNodeId));
    const countByNode = new Map<string, number>();
    for (const n of activeNodes) countByNode.set(n.id, 0);
    for (const t of tenants) {
      if (t.assignedNodeId && activeNodeIds.has(t.assignedNodeId)) {
        countByNode.set(t.assignedNodeId, (countByNode.get(t.assignedNodeId) ?? 0) + 1);
      }
    }

    for (const t of orphans) {
      // Legkevésbé terhelt node kiválasztása a futásközbeni számláló alapján
      // (nem a DB-t kérdezzük le újra minden árva után – ez egy tick alatt
      // legfeljebb néhány tíz tenantnál fut, ez elhanyagolható pontatlanság).
      let target = activeNodes[0];
      let targetCount = countByNode.get(target.id) ?? 0;
      for (const n of activeNodes.slice(1)) {
        const c = countByNode.get(n.id) ?? 0;
        if (c < targetCount) { target = n; targetCount = c; }
      }
      await reassignTenant(t.id, target.id, "orphan");
      countByNode.set(target.id, targetCount + 1);
    }

    // ── 2) Egyenletesség-pass, hiszterézissel, max 1 mozgatás/tick ─────────
    const totalTenants = tenants.length; // az árvák már újraszámolva fent, de a
    // teljes darabszám ettől nem változik – a cél-átlag ugyanaz marad.
    const targetPerNode = Math.ceil(totalTenants / activeNodes.length);

    const overloadedNow = new Set<string>();
    for (const n of activeNodes) {
      const c = countByNode.get(n.id) ?? 0;
      if (c > targetPerNode) overloadedNow.add(n.id);
    }

    // Streak-számlálók frissítése: csak az aktuálisan túlterhelt node-oknak
    // nő a streakje, a többinek nullázódik (vagy törlődik a Map-ből).
    for (const n of activeNodes) {
      if (overloadedNow.has(n.id)) {
        _overloadStreak.set(n.id, (_overloadStreak.get(n.id) ?? 0) + 1);
      } else {
        _overloadStreak.delete(n.id);
      }
    }
    // Már nem aktív node-ok streakjét is töröljük, ne szivárogjon a Map.
    for (const nodeId of [..._overloadStreak.keys()]) {
      if (!activeNodeIds.has(nodeId)) _overloadStreak.delete(nodeId);
    }

    const readyToRebalance = activeNodes.find(
      (n) => (_overloadStreak.get(n.id) ?? 0) >= env.CLUSTER_REBALANCE_OVERLOAD_TICKS
    );

    if (readyToRebalance) {
      // Csengetés-tudatos biztonságos-ablak: PUSZTÁN egyenletesítés miatt
      // (nem árva-tenant miatt) csak olyan tenantot mozgatunk, amelyiknek
      // MOST nincs csengetése/szünete a közelben (ld. rebalance-safe-window.ts).
      // Ha egyik tenant sem biztonságos most, kihagyjuk EZT a tickét – a
      // streak NEM törlődik, a köv. tickben újra próbálkozunk, amint
      // bármelyik tenant biztonságos ablakba ér.
      const candidatesOnNode = tenants.filter((t) => t.assignedNodeId === readyToRebalance.id);
      const safeIds = await computeSafeTenantIds(candidatesOnNode.map((t) => t.id));
      const candidateTenant = candidatesOnNode.find((t) => safeIds.has(t.id));

      if (!candidateTenant) {
        console.log(`[CLUSTER-REBALANCER] ${readyToRebalance.hostname} túlterhelt, de nincs most biztonságos-ablakban lévő tenantja — kihagyva ebben a tickben`);
      } else {
        let target = activeNodes[0];
        let targetCount = countByNode.get(target.id) ?? 0;
        for (const n of activeNodes.slice(1)) {
          const c = countByNode.get(n.id) ?? 0;
          if (c < targetCount) { target = n; targetCount = c; }
        }
        if (target.id !== readyToRebalance.id) {
          await reassignTenant(candidateTenant.id, target.id, "rebalance");
          _overloadStreak.delete(readyToRebalance.id); // friss állapot, újraindul a számlálás
        }
      }
    }
  } catch (e) {
    console.error("[CLUSTER-REBALANCER] tick hiba:", e);
  }
}

export function startClusterRebalancer(): void {
  if (_running) return;
  _running = true;
  console.log(
    `[CLUSTER-REBALANCER] Indult (tick: ${env.CLUSTER_REBALANCE_INTERVAL_MS}ms, dead_threshold: ${env.CLUSTER_NODE_DEAD_THRESHOLD_MS}ms, overload_ticks: ${env.CLUSTER_REBALANCE_OVERLOAD_TICKS})`
  );
  void tick();
  setInterval(() => void tick(), env.CLUSTER_REBALANCE_INTERVAL_MS);
}
