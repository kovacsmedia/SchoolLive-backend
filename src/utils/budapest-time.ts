// src/utils/budapest-time.ts
//
// Közös Budapest-időzóna segédfüggvények. Korábban `todayInBudapest()` és
// `getBellMs()` szó szerint duplikálva volt a bells.routes.ts és a
// bell.scheduler.ts fájlokban – ez a modul az egyetlen forrás mindkettőnek,
// plusz a rebalance-safe-window.ts-nek (ld. terv "Kör 2" B szakasza).

/** UTC-éjféli Date objektum az aktuális helyi (Europe/Budapest) naptári napra. */
export function todayInBudapest(now: Date = new Date()): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const [year, month, day] = fmt.format(now).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Egy adott helyi (Europe/Budapest) óra:perc UTC epoch ms-e A `now`
 * PARAMÉTER NAPTÁRI NAPJÁRA nézve (DST-helyes – nem egyszerű óra-eltolás,
 * hanem tényleges timezone-konverzió, mert nyári/téli időszámítás
 * határnapján egy fix eltolás hibás lenne).
 *
 * FONTOS – a korábbi implementáció csak UTC szerver-időzónában adott helyes
 * eredményt. A `new Date(d.toLocaleString("en-US", {timeZone}))` trükk a
 * visszaparszolásnál a SZERVER lokális időzónáját használja, így a kiszámolt
 * eltolásba beleszivárgott a szerver saját offsetje: az eredmény
 * `helyes + serverOffset` lett. Az első node UTC-n fut, ezért ez sosem
 * derült ki – de egy `TZ=Europe/Budapest` beállítású új node-on MINDEN
 * csengetés 1-2 órával elcsúszott volna.
 *
 * Az alábbi változat nem függ a szerver időzónájától: az `Intl` formatterrel
 * KIOLVASSA, hogy egy adott UTC pillanat mennyi Budapesten, és ebből
 * számolja a tényleges offsetet.
 */
function budapestOffsetMsAt(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? "0");
  // A budapesti fali-óra ugyanezekkel a mezőkkel, UTC-ként értelmezve.
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"),
                         get("hour"), get("minute"), get("second"));
  return asUtc - utcMs;   // pl. CEST-ben +2h
}

export function getBellMs(hour: number, minute: number, now: Date = new Date()): number {
  const budapestDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const [y, m, d] = budapestDateStr.split("-").map(Number);

  // A keresett fali-óra UTC-ként értelmezve – ebből az offset levonásával
  // kapjuk a tényleges UTC pillanatot.
  const wallAsUtc = Date.UTC(y, m - 1, d, hour, minute, 0);

  // Az offsetet magánál a találgatott pillanatnál mérjük, majd egyszer
  // korrigálunk: DST-váltás napján az első becslés még a váltás rossz
  // oldalára eshet, a második már nem.
  let guess = wallAsUtc - budapestOffsetMsAt(wallAsUtc);
  guess     = wallAsUtc - budapestOffsetMsAt(guess);
  return guess;
}

/** Hétvége-e (Europe/Budapest) a `now` időpontban. */
export function isBudapestWeekend(now: Date = new Date()): boolean {
  const dayOfWeek = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Budapest", weekday: "short",
  }).format(now);
  return dayOfWeek === "Sat" || dayOfWeek === "Sun";
}

/** Aktuális (Europe/Budapest) naptári dátum és óra:perc, fájlnév-célra
 *  (pl. TTS-generálás – ld. tts.service.ts) – `{ date: "YYYY-MM-DD", hm: "HHmm" }`. */
export function budapestDateTimeParts(now: Date = new Date()): { date: string; hm: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hm:   `${get("hour")}${get("minute")}`,
  };
}
