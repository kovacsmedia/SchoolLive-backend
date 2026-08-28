// src/modules/cluster/rebalance-safe-window.ts
//
// Eldönti, hogy EGY ADOTT tenant esetében biztonságos-e MOST önkéntes
// (nem-orphan) rebalancing-ot végezni – azaz a rebalancer evenness-passa
// átmozgathatja-e csendben egy másik node-ra anélkül, hogy csengetést vagy
// órai szünetet zavarna.
//
// NEM vonatkozik az árva-tenant (halott node) áthelyezésre – ott a tenant
// már úgyis néma, nincs mit védeni, a rebalancer ezt a modult nem hívja
// arra az ágra.
//
// Szabály (ld. terv Kör 2, B.1):
//   1. Ünnepnap → biztonságos.
//   2. Hétvége ÉS nincs explicit naptár-felülírás (ugyanaz a feltétel, mint
//      bell.scheduler.ts scheduleTenantBells-jében) → biztonságos.
//   3. Nincs egyetlen MAIN csengetés sem ma → biztonságos.
//   4. `now` az 5 perces (env-ből állítható) sávban BÁRMELYIK MAIN csengetés
//      körül → NEM biztonságos.
//   5. Az iskolanap (első/utolsó MAIN csengetés, sávval csökkentve) előtt/
//      után → biztonságos.
//   6. Két egymást követő MAIN közötti résben: ha a rés ≥ küszöb (env,
//      alapértelmezett 25 perc) → biztonságos (tanóra), egyébként → NEM
//      biztonságos (szünet).

import { prisma } from "../../prisma/client";
import { env } from "../../config/env";
import { todayInBudapest, getBellMs, isBudapestWeekend } from "../../utils/budapest-time";

export async function computeSafeTenantIds(
  tenantIds: string[],
  now: Date = new Date()
): Promise<Set<string>> {
  const safe = new Set<string>();
  if (tenantIds.length === 0) return safe;

  const today = todayInBudapest(now);

  // Batch: max 2 lekérdezés, NEM tenantonként (ld. terv B.3 – ezt a
  // függvényt a rebalancer csak akkor hívja, amikor egy node már 3 tickje
  // túlterhelt, és csak az arra a node-ra eső néhány tenantra, nem
  // mindegyikre minden tickben).
  const [calDays, defaultTemplates] = await Promise.all([
    prisma.bellCalendarDay.findMany({
      where: { tenantId: { in: tenantIds }, date: today },
      select: {
        tenantId: true,
        isHoliday: true,
        template: {
          select: {
            bells: {
              where: { type: "MAIN" },
              select: { hour: true, minute: true },
              orderBy: [{ hour: "asc" }, { minute: "asc" }],
            },
          },
        },
      },
    }),
    prisma.bellScheduleTemplate.findMany({
      where: { tenantId: { in: tenantIds }, isDefault: true },
      select: {
        tenantId: true,
        bells: {
          where: { type: "MAIN" },
          select: { hour: true, minute: true },
          orderBy: [{ hour: "asc" }, { minute: "asc" }],
        },
      },
    }),
  ]);

  const calDayByTenant     = new Map(calDays.map((c) => [c.tenantId, c]));
  const defaultByTenant    = new Map(defaultTemplates.map((t) => [t.tenantId, t]));
  const weekend            = isBudapestWeekend(now);
  const nowMs              = now.getTime();
  const bufferMs           = env.CLUSTER_REBALANCE_BELL_BUFFER_MIN * 60_000;
  const breakThresholdMs   = env.CLUSTER_REBALANCE_BREAK_THRESHOLD_MIN * 60_000;

  for (const tenantId of tenantIds) {
    const calDay = calDayByTenant.get(tenantId);

    if (calDay?.isHoliday) {
      safe.add(tenantId);
      continue;
    }

    // Ugyanaz a feltétel, mint bell.scheduler.ts scheduleTenantBells-ben:
    // hétvégén NEM ellenőrizzük a "van-e csengetés" tényt bell-számláláson
    // kívül – resolveTodayBells maga NEM néz hétvégét, ezt itt KELL
    // pótolni, különben egy hétvégi default-sablon tévesen "van csengetés"
    // eredményt adna.
    const hasExplicitTemplate = !!calDay?.template?.bells?.length;
    if (weekend && !hasExplicitTemplate) {
      safe.add(tenantId);
      continue;
    }

    const bells = hasExplicitTemplate
      ? calDay!.template!.bells
      : (defaultByTenant.get(tenantId)?.bells ?? []);

    if (bells.length === 0) {
      safe.add(tenantId);
      continue;
    }

    const bellMsList = bells
      .map((b) => getBellMs(b.hour, b.minute, now))
      .sort((a, b) => a - b);

    const nearAnyBell = bellMsList.some((ms) => Math.abs(nowMs - ms) < bufferMs);
    if (nearAnyBell) continue; // NEM biztonságos – nincs safe.add()

    const first = bellMsList[0];
    const last  = bellMsList[bellMsList.length - 1];

    if (nowMs < first - bufferMs || nowMs > last + bufferMs) {
      // Iskolanap előtt/után
      safe.add(tenantId);
      continue;
    }

    // Melyik résbe esik `now`, és az a rés tanóra-e (biztonságos) vagy
    // szünet (nem biztonságos)?
    for (let i = 0; i < bellMsList.length - 1; i++) {
      if (nowMs > bellMsList[i] && nowMs < bellMsList[i + 1]) {
        const gapMs = bellMsList[i + 1] - bellMsList[i];
        if (gapMs >= breakThresholdMs) safe.add(tenantId);
        break;
      }
    }
  }

  return safe;
}
