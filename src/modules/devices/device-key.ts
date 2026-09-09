// src/modules/devices/device-key.ts
//
// Eszközkulcs (x-device-key / WS ?deviceKey=) → Device feloldás, egy helyen.
//
// KORÁBBAN ugyanez a minta KILENC helyen volt lemásolva (deviceAuth middleware,
// SyncEngine WS accept, bells.routes authenticateDevice, devices.native.routes
// ×3, firmware.routes ×2): lekérdezte az ÖSSZES eszközt, majd soronként
// `bcrypt.compare`-t futtatott, amíg talált. Ez eszközszámmal lineáris, és a
// bcrypt SZÁNDÉKOSAN lassú (~50-100 ms / összehasonlítás, cost=10) – egy
// backend-újraindítás utáni tömeges újracsatlakozásnál ez percekig 100% CPU-t
// jelent, és lényegében egy önmagunk ellen indított DoS.
//
// Mostantól: a kulcs SHA-256 lenyomata egy INDEXELT oszlopban
// (`Device.deviceKeyLookup`) kiválasztja az egyetlen szóba jövő sort, és
// pontosan EGY bcrypt.compare fut rá. A bcrypt marad az egyetlen hitelesítő –
// a SHA csak index, nem helyettesíti az ellenőrzést.
//
// Visszafelé kompatibilis, önmagát gyógyító:
//   • A natív eszközök (Android / Python) provisioningkor a KÉSZ bcrypt hasht
//     küldik fel, a szerver a nyílt kulcsot sosem látja – náluk a lookup
//     mező kezdetben üres.
//   • Ilyenkor a régi, teljes keresés fut le, DE csak azokra a sorokra,
//     amelyeknek még nincs lookup értékük – és az első sikeres találatnál
//     kitöltjük. A második hitelesítéstől kezdve az adott eszköz már O(1).

import crypto from "crypto";
import bcrypt from "bcrypt";
import { prisma } from "../../prisma/client";

/** A nyílt eszközkulcs indexelhető lenyomata. NEM jelszó-hash: az eszközkulcs
 *  nagy entrópiájú, véletlen generált érték, itt csak keresési kulcsként
 *  használjuk – a tényleges hitelesítést a bcrypt végzi. */
export function deviceKeyLookupHash(deviceKey: string): string {
  return crypto.createHash("sha256").update(deviceKey).digest("hex");
}

export type ResolvedDevice = {
  id: string;
  tenantId: string;
  deviceKeyHash: string | null;
};

// MULTIZONE eszközöknél NÉGY Device sor osztozik UGYANAZON a deviceKey-en
// (a master Z1 + a Z2-Z4 zónák), tehát a kulcs több sorra is illeszkedhet.
// A ténylegesen csatlakozó fizikai eszköz a MASTER (parentDeviceId = null),
// ezért azt részesítjük előnyben – a korábbi implementációk itt a findMany
// meghatározatlan sorrendjére bízták magukat.
function masterFirst<T extends { parentDeviceId?: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    (a.parentDeviceId ? 1 : 0) - (b.parentDeviceId ? 1 : 0));
}

/**
 * Feloldja a nyílt eszközkulcsot Device rekordra, vagy null-t ad.
 *
 * @param deviceKey a kliens által küldött nyílt kulcs
 * @param onlyKeyAuth ha true, csak `authType: "KEY"` eszközöket vesz
 *        figyelembe (néhány régi hívási hely így szűrt)
 */
export async function findDeviceByKey(
  deviceKey: string,
  onlyKeyAuth = false,
): Promise<ResolvedDevice | null> {
  if (!deviceKey) return null;

  const lookup = deviceKeyLookupHash(deviceKey);
  // Konkrét típus (nem unió), hogy a Prisma `where` spread-elése
  // egyértelmű maradjon a fordítónak.
  const authFilter: { authType?: "KEY" } = onlyKeyAuth ? { authType: "KEY" } : {};

  // ── Gyors út: indexelt találat, pontosan egy bcrypt ellenőrzéssel ────────
  const candidates = await prisma.device.findMany({
    where:  { deviceKeyLookup: lookup, ...authFilter },
    select: { id: true, tenantId: true, deviceKeyHash: true, parentDeviceId: true },
  });
  for (const d of masterFirst(candidates)) {
    if (!d.deviceKeyHash) continue;
    if (await bcrypt.compare(deviceKey, d.deviceKeyHash)) return d;
  }

  // ── Lassú út: csak a MÉG NEM backfillelt sorok ───────────────────────────
  // Ez a halmaz minden sikeres hitelesítéssel eggyel kisebb lesz, tehát a
  // migráció magától lefut, külön szkript nélkül.
  const legacy = await prisma.device.findMany({
    where:  { deviceKeyLookup: null, deviceKeyHash: { not: null }, ...authFilter },
    select: { id: true, tenantId: true, deviceKeyHash: true, parentDeviceId: true },
  });
  for (const d of masterFirst(legacy)) {
    if (!d.deviceKeyHash) continue;
    if (!(await bcrypt.compare(deviceKey, d.deviceKeyHash))) continue;

    // Backfill – a következő hitelesítés már az indexen keresztül megy.
    // Hibát elnyelünk: a hitelesítés maga sikeres volt, ezen nem bukhat el.
    try {
      // updateMany az azonos bcrypt hash-ű ÖSSZES sorra: MULTIZONE-nál a
      // master és a zónák ugyanazt a kulcsot használják, így egy körben
      // mindegyik megkapja a lookup értéket.
      await prisma.device.updateMany({
        where: { deviceKeyHash: d.deviceKeyHash, deviceKeyLookup: null },
        data:  { deviceKeyLookup: lookup },
      });
    } catch (e) {
      console.warn(`[device-key] lookup backfill hiba (${d.id}):`, e);
    }
    return d;
  }

  return null;
}
