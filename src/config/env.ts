import os from "os";

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: Number(process.env.PORT ?? 3000),
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET ?? "",
  // A TÉNYLEGES munkamenet-életciklust a UserSession tábla vezérli (ld.
  // auth.service.ts login()/logout(), authJwt.ts) – egy sor törlése azonnal
  // érvényteleníti a hozzá tartozó tokent, FÜGGETLENÜL ennek a lejáratától.
  // Emiatt maga a JWT lejárati ideje itt csak egy nagyon távoli, defenzív
  // felső korlát: a user NE essen ki írás/gépelés közben egy régi, rövid
  // (15 perces) TTL miatt – ez volt a korábbi zavaró viselkedés.
  JWT_ACCESS_TTL: process.env.JWT_ACCESS_TTL ?? "3650d",

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

  /**
   * A kifelé hirdetett alap-URL – ebből épül minden olyan link, amit KLIENS
   * kap meg (hangfájlok, firmware, üzenet-hangok).
   *
   * EGY HELYEN. Korábban öt különböző fájlban ismétlődött a
   * `process.env.BASE_URL ?? "https://api.schoollive.hu"` minta; egy új
   * helyen könnyű lemaradni az alapértékről, és akkor a kliens `undefined`
   * kezdetű URL-t kapna.
   */
  BASE_URL: process.env.BASE_URL ?? "https://api.schoollive.hu",

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

/**
 * Egy TÁROLT, abszolút URL visszahorgonyzása az AKTUÁLIS alap-URL-re.
 *
 * MIÉRT KELL: a `RadioFile.fileUrl` és a `Message.fileUrl` teljes URL-ként
 * kerül az adatbázisba, a létrehozás pillanatában érvényes hoszttal. Ez
 * két esetben hazudik:
 *
 *   1. A tesztszerveren egy éles adatbázis-másolattal a sorok az ÉLES hosztra
 *      mutatnak – a mixer onnan töltötte le a hangot, és a teszt nem volt
 *      önálló. (Élesben megfigyelve, 2026-09-18.)
 *   2. Ha a domain valaha változik, MINDEN régi sor törött linkké válik.
 *
 * Csak a saját kiszolgálású útvonalakat írja át (`/uploads/`, `/audio/`,
 * `/firmware/`); egy külső URL-hez (pl. internetrádió streamje) nem nyúl.
 */
export function rehostUrl(stored: string | null | undefined): string {
  if (!stored) return "";
  try {
    const u = new URL(stored);
    if (!/^\/(uploads|audio|firmware)\//.test(u.pathname)) return stored;
    return `${env.BASE_URL.replace(/\/+$/, "")}${u.pathname}${u.search}`;
  } catch {
    // Nem abszolút URL (régi, relatív sor) – az alap-URL elé fűzzük.
    return stored.startsWith("/") ? `${env.BASE_URL.replace(/\/+$/, "")}${stored}` : stored;
  }
}
