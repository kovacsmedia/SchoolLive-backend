// src/modules/cluster/cluster.alerts.ts
//
// Minimális, opcionális riasztás cluster-eseményekre (node halál/visszatérés,
// leader-váltás). Ha CLUSTER_ALERT_WEBHOOK_URL üres, teljesen no-op. Szándékosan
// nincs metrika-store/dashboard/APM – csak egy sima webhook POST, ami sosem
// dobhat hibát a hívó cluster-logikára nézve.

import { env } from "../../config/env";

export async function notify(event: string, payload: object): Promise<void> {
  if (!env.CLUSTER_ALERT_WEBHOOK_URL) return;

  try {
    await fetch(env.CLUSTER_ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, ...payload, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    // Sosem befolyásolhatja a cluster-logikát – csak logoljuk.
    console.warn(`[CLUSTER-ALERTS] webhook hiba (${event}):`, e);
  }
}
