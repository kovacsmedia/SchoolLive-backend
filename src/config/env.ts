import os from "os";

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: Number(process.env.PORT ?? 3000),
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET ?? "",
  JWT_ACCESS_TTL: process.env.JWT_ACCESS_TTL ?? "15m",

  // ── Multi-node cluster ─────────────────────────────────────────────────
  //
  // NODE_HOSTNAME KELL egyezzen a ClusterNode.hostname értékkel és a node
  // publikus DNS nevével (api.schoollive.hu / api2.schoollive.hu / ...) –
  // ez az érték kerül ki a kliensekhez is (Snapcast cél, /cluster/locate
  // válasz). os.hostname() csak dev-fallback: éles .env-ben MINDIG expliciten
  // be kell állítani, különben a gép rövid/lokális hostname-je szivárogna ki
  // a kliensekhez, ami nem használható DNS névként.
  NODE_HOSTNAME: process.env.NODE_HOSTNAME ?? os.hostname(),

  CLUSTER_HEARTBEAT_INTERVAL_MS:       Number(process.env.CLUSTER_HEARTBEAT_INTERVAL_MS ?? 5_000),
  CLUSTER_NODE_DEAD_THRESHOLD_MS:      Number(process.env.CLUSTER_NODE_DEAD_THRESHOLD_MS ?? 20_000),
  CLUSTER_LEASE_TTL_MS:                Number(process.env.CLUSTER_LEASE_TTL_MS ?? 15_000),
  CLUSTER_LEASE_RENEW_INTERVAL_MS:     Number(process.env.CLUSTER_LEASE_RENEW_INTERVAL_MS ?? 5_000),
  CLUSTER_REBALANCE_INTERVAL_MS:       Number(process.env.CLUSTER_REBALANCE_INTERVAL_MS ?? 10_000),
  CLUSTER_OWNERSHIP_POLL_INTERVAL_MS:  Number(process.env.CLUSTER_OWNERSHIP_POLL_INTERVAL_MS ?? 5_000),
  // Hány egymást követő rebalancer-tick óta kell egy node-nak túlterheltnek
  // lennie, mielőtt PUSZTÁN egyenletesítés miatt (nem árva-tenant miatt)
  // elmozdítunk róla egy tenantot – lebegő node elleni védelem.
  CLUSTER_REBALANCE_OVERLOAD_TICKS:    Number(process.env.CLUSTER_REBALANCE_OVERLOAD_TICKS ?? 3),

  // Csengetés-tudatos rebalance-ablak (ld. rebalance-safe-window.ts). CSAK
  // az önkéntes (nem-orphan) egyenletesítő átrendezésre vonatkozik – halott
  // node tenantjai ettől függetlenül azonnal átkerülnek.
  //
  // BELL_BUFFER_MIN: ennyi perccel bármelyik MAIN csengetés előtt/után NEM
  // szabad átrendezni.
  // BREAK_THRESHOLD_MIN: két egymást követő MAIN csengetés közötti rés ez
  // ALATT szünetnek (tilos), FÖLÖTTE tanórának (engedélyezett) számít – fix,
  // hangolható küszöb, nem statisztikai becslés (ld. terv indoklása).
  CLUSTER_REBALANCE_BELL_BUFFER_MIN:     Number(process.env.CLUSTER_REBALANCE_BELL_BUFFER_MIN ?? 5),
  CLUSTER_REBALANCE_BREAK_THRESHOLD_MIN: Number(process.env.CLUSTER_REBALANCE_BREAK_THRESHOLD_MIN ?? 25),

  // Üres = kikapcsolva, nincs kimenő webhook-hívás.
  CLUSTER_ALERT_WEBHOOK_URL: process.env.CLUSTER_ALERT_WEBHOOK_URL ?? "",

  // ── Lokalizáció ────────────────────────────────────────────────────────
  //
  // Google Cloud Translation v2 REST API kulcs (üzenet-fordítás, ld.
  // src/services/translate.service.ts). MINDEN app-node .env-jében kell,
  // mert bármelyik node kaphat /messages/translate kérést az adott tenant
  // szerint.
  GOOGLE_TRANSLATE_API_KEY: process.env.GOOGLE_TRANSLATE_API_KEY ?? "",
};

// UI-nyelv és TTS-fordítás célnyelvek allowlist-je (ISO 639-1). A magyar a
// forrás/default nyelv, a többi 8 a UI-választóban ÉS a TTS-fordítás
// célnyelv-listájában is megjelenik.
export const SUPPORTED_LOCALES = ["hu", "en", "de", "sk", "pl", "ro", "uk", "sr", "hr"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
