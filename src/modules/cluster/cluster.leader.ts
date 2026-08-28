// src/modules/cluster/cluster.leader.ts
//
// Dinamikus master-választás, DB-backed lease-sel (nem etcd/Consul/Raft –
// a Postgres már amúgy is az egyetlen közös koordinációs pont, ld. terv).
// A ClusterLeaderLease singleton sorért ("id"="singleton") atomikus
// compare-and-swap UPDATE-tel versenyeznek a node-ok, ugyanazzal a
// `updateMany` + `.count` mintával, mint a SyncEngine.ts pushPendingCommands
// optimista update-je (src/sync/SyncEngine.ts:659-663).

import { prisma } from "../../prisma/client";
import { env } from "../../config/env";
import { getSelfNodeId } from "./cluster.heartbeat";
import { notify } from "./cluster.alerts";

const SINGLETON_ID = "singleton";

let _running = false;
let _isLeader = false;

export function isLeader(): boolean {
  return _isLeader;
}

async function tick(): Promise<void> {
  const selfNodeId = getSelfNodeId();
  if (!selfNodeId) return; // a heartbeat még nem regisztrálta ezt a node-ot

  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.CLUSTER_LEASE_TTL_MS);

  try {
    // Megszerezzük/megújítjuk a lease-t, ha: senki nem tartja, lejárt, VAGY
    // mi tartjuk (renewal). Az `updateMany` + count===1 ellenőrzés atomikus –
    // két node egyszerre soha nem "nyerhet".
    const result = await prisma.clusterLeaderLease.updateMany({
      where: {
        id: SINGLETON_ID,
        OR: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lt: now } },
          { leaderNodeId: selfNodeId },
        ],
      },
      data: { leaderNodeId: selfNodeId, leaseExpiresAt: expiresAt },
    });

    const wasLeader = _isLeader;
    _isLeader = result.count === 1;

    if (_isLeader && !wasLeader) {
      console.log(`[CLUSTER-LEADER] 👑 Leader lettem (${env.NODE_HOSTNAME})`);
      void notify("leader_changed", { newLeaderHostname: env.NODE_HOSTNAME });
    } else if (!_isLeader && wasLeader) {
      console.log("[CLUSTER-LEADER] Elvesztettem a leader szerepet");
    }
  } catch (e) {
    console.error("[CLUSTER-LEADER] tick hiba:", e);
  }
}

// Graceful step-down: ha épp mi vagyunk a leader, azonnal elengedjük a
// lease-t, hogy egy rutin `pm2 reload` deploy ne okozzon felesleges,
// a lease lejáratáig tartó failover-ablakot minden push-nál. Hívja a
// server.ts SIGTERM handlere, a szerver-leállítás előtt.
export async function releaseLeadershipIfHeld(): Promise<void> {
  const selfNodeId = getSelfNodeId();
  if (!selfNodeId || !_isLeader) return;

  try {
    await prisma.clusterLeaderLease.updateMany({
      where: { id: SINGLETON_ID, leaderNodeId: selfNodeId },
      data: { leaderNodeId: null, leaseExpiresAt: null },
    });
    console.log("[CLUSTER-LEADER] Lease elengedve (graceful shutdown)");
  } catch (e) {
    console.error("[CLUSTER-LEADER] releaseLeadershipIfHeld hiba:", e);
  }
}

export function startLeaderElection(): void {
  if (_running) return;
  _running = true;
  console.log(
    `[CLUSTER-LEADER] Indult (lease TTL: ${env.CLUSTER_LEASE_TTL_MS}ms, renewal: ${env.CLUSTER_LEASE_RENEW_INTERVAL_MS}ms)`
  );

  // A singleton sornak léteznie kell, mielőtt bármelyik node CAS-elni tudna
  // rá – a migráció már seedeli, ez csak védőháló, ha valamiért mégsem
  // létezne (pl. valaki kézzel törölte).
  void prisma.clusterLeaderLease
    .upsert({ where: { id: SINGLETON_ID }, update: {}, create: { id: SINGLETON_ID } })
    .then(() => {
      void tick();
      setInterval(() => void tick(), env.CLUSTER_LEASE_RENEW_INTERVAL_MS);
    })
    .catch((e) => console.error("[CLUSTER-LEADER] singleton seed hiba:", e));
}
