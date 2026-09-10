// src/modules/firmware/firmware-version.ts
//
// Firmware-verziók összehasonlítása.
//
// MIÉRT KELL: a `/firmware/check` korábban a LEGUTÓBB FELTÖLTÖTT release-t
// (`orderBy: createdAt desc`) ajánlotta ki, függetlenül attól, hogy annak a
// verziószáma nagyobb-e a futónál. Ha valaki egy régi .bin-t tölt fel újra
// (vagy a legfrissebb sort törlik), a mezőny "legújabbja" hirtelen egy RÉGEBBI
// verzió lesz, és minden eszköz VISSZAFRISSÜL rá. 2026-09-10-én pontosan ez
// történt: S5.1 -> S3.52 downgrade indult el, a fájlt közben törölték, a
// letöltés 404-re futott, és a megszakadt OTA a snap-kliens újraindításán
// keresztül pánikot okozott az eszközön.
//
// A formátum "S<major>.<minor>" (S3.52, S4.9, S5.0, S5.1), de szándékosan
// megengedő a parser: bármilyen prefix + pontokkal tagolt számsorozat megy,
// és a nem szám részeket figyelmen kívül hagyjuk. Ismeretlen alakú verziónál
// null-t adunk vissza, és a hívó ilyenkor NEM frissít – a "ne downgrade-eljünk"
// szabály fontosabb, mint hogy minden áron jusson frissítés.

/** "S5.1" → [5, 1];  "3.52.1" → [3, 52, 1];  "béta" → null */
export function parseFirmwareVersion(v: string | null | undefined): number[] | null {
  if (!v) return null;
  const parts = String(v).trim().replace(/^[^0-9]*/, "").split(".");
  if (parts.length === 0 || parts[0] === "") return null;

  const nums: number[] = [];
  for (const p of parts) {
    const m = /^(\d+)/.exec(p.trim());
    if (!m) break;                 // "1.2-rc3" → [1, 2], a farok nem érdekel
    nums.push(parseInt(m[1], 10));
  }
  return nums.length ? nums : null;
}

/**
 * -1 ha a < b, 0 ha egyenlő, 1 ha a > b.
 * null, ha bármelyik verzió nem értelmezhető (a hívónak döntenie kell).
 *
 * A hiányzó tagokat 0-nak vesszük: "S5" === "S5.0".
 */
export function compareFirmwareVersions(a: string, b: string): number | null {
  const pa = parseFirmwareVersion(a);
  const pb = parseFirmwareVersion(b);
  if (!pa || !pb) return null;

  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Szigorúan újabb-e a `candidate` a `current`-nél? Bizonytalanság esetén false. */
export function isNewerFirmware(candidate: string, current: string): boolean {
  const cmp = compareFirmwareVersions(candidate, current);
  return cmp === 1;
}
