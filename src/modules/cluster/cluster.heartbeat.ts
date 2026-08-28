// src/modules/cluster/cluster.heartbeat.ts
//
// Minden node-on fut (nem csak a leaderen). Periodikusan upsertel egy sort
// a saját ClusterNode.hostname-jére, "status: ACTIVE"-tal – ez egyben
// magától "gyógyítja" a visszatérő node-ot is (nincs külön rejoin-ág),
// mert a leader csak addig tartja DEAD-nek, amíg a heartbeat elmarad.
//
// A halott node ÉSZLELÉSE (heartbeat-küszöb túllépés → DEAD) NEM itt
// történik, hanem kizárólag a leader cluster.rebalancer.ts tickjében –
// így nem versenyez minden node egymással ugyanazon sorok írásáért.

import { prisma } from "../../prisma/client";
import { env } from "../../config/env";

let _running = false;
let _selfNodeId: string | null = null;

export function getSelfNodeId(): string | null {
  return _selfNodeId;
}

async function tick(): Promise<void> {
  try {
    // Ha a saját sorunk jelenleg DRAINING (admin kézi staging – ld.
    // cluster.admin.routes.ts PATCH /nodes/:id), a heartbeat CSAK a
    // lastHeartbeatAt-ot frissítse, a status-t NE írja felül ACTIVE-ra.
    // Enélkül a DRAINING minden tickben (5mp) visszaállna ACTIVE-ra, és a
    // rebalancer azonnal tenantot adhatna egy szándékosan "üresen tartott"
    // node-nak (pl. mielőtt a kliens-oldali discovery készen állna rá).
    if (_selfNodeId) {
      const r = await prisma.clusterNode.updateMany({
        where: { id: _selfNodeId, status: "DRAINING" },
        data: { lastHeartbeatAt: new Date() },
      });
      if (r.count > 0) return;
    }

    const row = await prisma.clusterNode.upsert({
      where: { hostname: env.NODE_HOSTNAME },
      update: { lastHeartbeatAt: new Date(), status: "ACTIVE" },
      create: { hostname: env.NODE_HOSTNAME, lastHeartbeatAt: new Date(), status: "ACTIVE" },
    });
    _selfNodeId = row.id;
  } catch (e) {
    console.error("[CLUSTER-HEARTBEAT] tick hiba:", e);
  }
}

export function startClusterHeartbeat(): void {
  if (_running) return;
  _running = true;
  console.log(
    `[CLUSTER-HEARTBEAT] Indult (hostname=${env.NODE_HOSTNAME}, tick: ${env.CLUSTER_HEARTBEAT_INTERVAL_MS}ms)`
  );

  void tick();
  setInterval(() => void tick(), env.CLUSTER_HEARTBEAT_INTERVAL_MS);
}
