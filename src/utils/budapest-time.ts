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
 */
export function getBellMs(hour: number, minute: number, now: Date = new Date()): number {
  const budapestDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const [y, m, d] = budapestDateStr.split("-").map(Number);
  const bellLocalStr = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  const tempDate   = new Date(`${bellLocalStr}Z`);
  const budapestMs = new Date(tempDate.toLocaleString("en-US", { timeZone: "Europe/Budapest" })).getTime();
  const offsetMs   = tempDate.getTime() - budapestMs;
  return new Date(`${bellLocalStr}Z`).getTime() + offsetMs;
}

/** Hétvége-e (Europe/Budapest) a `now` időpontban. */
export function isBudapestWeekend(now: Date = new Date()): boolean {
  const dayOfWeek = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Budapest", weekday: "short",
  }).format(now);
  return dayOfWeek === "Sat" || dayOfWeek === "Sun";
}
