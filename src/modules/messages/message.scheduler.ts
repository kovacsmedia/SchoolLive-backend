// src/modules/messages/message.scheduler.ts
//
// Időzített üzenetek (Message.scheduledAt) tényleges kiküldése.
//
// KORÁBBAN: a POST /messages, POST /messages/audio és POST /messages/:id/replay
// jövőbeli `scheduledAt` esetén CSAK QUEUED DeviceCommand sorokat írt, a
// payloadba téve a `scheduledAt`-ot – de egyetlen kliens sem olvasta ezt a
// mezőt (ESP32 / Android / Linux / Windows: 0 találat), és nem is volt semmi,
// ami a megadott pillanatban elindította volna a Snapcast lejátszást. Az
// időzített üzenet így vagy sosem szólalt meg, vagy rossz időben (a következő
// eszköz-újracsatlakozáskor a `pushPendingCommands` kitolta a sorban álló
// parancsot). Ez a scheduler pótolja a hiányzó ütemezőt – a bells és a radio
// már rendelkezett ilyennel.
//
// Működés a radio.scheduler.ts mintájára:
//   • 10 mp-es tick, 15 mp-es előretekintés
//   • a pontos pillanatra setTimeout, hogy ne a tick-rácsra kerekedjen
//   • stale-védelem: a régmúltban esedékes üzenet nem szólal meg utólag
//     (pl. hosszabb backend-leállás után) – csak lezártnak jelöljük
//
// Multi-node: CSAK a saját node-hoz rendelt tenantok üzeneteit dolgozza fel
// (`isOwnedByThisNode`), különben minden node lejátszaná ugyanazt.

import { prisma } from "../../prisma/client";
import { isOwnedByThisNode } from "../cluster/tenant-ownership";
import {
  dispatchMessageNow,
  resolveTargetDeviceIds,
  getCandidateDeviceIds,
} from "./message.dispatch";

const TICK_INTERVAL_MS   = 10_000;
const LOOKAHEAD_MS       = 15_000;
// Ennél régebben esedékes üzenetet már nem játszunk le (a "10:00-ra időzített
// bemondás 11:20-kor megszólal" rosszabb, mint ha elmarad).
const STALE_THRESHOLD_MS = 60_000;

let _running = false;

// Már beütemezett (setTimeout-tal a memóriában várakozó) üzenetek – hogy a
// következő tick ne ütemezze be őket még egyszer.
const _pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Atomikus "enyém a lejátszás" igény: a `playedAt: null` feltételes update
 * pontosan egy hívónál ad `count === 1`-et. Ez zárja ki, hogy két tick (vagy
 * két node, ha az ownership épp váltana) kétszer játssza le ugyanazt.
 * Ugyanaz a minta, mint a SyncEngine.pushPendingCommands optimista update-je.
 */
async function claimMessage(messageId: string): Promise<boolean> {
  const r = await prisma.message.updateMany({
    where: { id: messageId, playedAt: null },
    data:  { playedAt: new Date() },
  });
  return r.count === 1;
}

async function fire(msg: {
  id: string;
  tenantId: string;
  title: string | null;
  text: string | null;
  fileUrl: string | null;
  targetType: string;
  targetId: string | null;
}): Promise<void> {
  _pendingTimeouts.delete(msg.id);

  // Az ownership a lejátszás pillanatában is igaz kell legyen – a tenant a
  // beütemezés óta átkerülhetett másik node-ra.
  if (!isOwnedByThisNode(msg.tenantId)) {
    console.log(`[MESSAGE-SCHEDULER] tenant=${msg.tenantId} már nem ezé a node-é – skip (${msg.id})`);
    return;
  }

  if (!msg.fileUrl) {
    console.warn(`[MESSAGE-SCHEDULER] ${msg.id}: nincs fileUrl – skip`);
    await claimMessage(msg.id);
    return;
  }

  if (!(await claimMessage(msg.id))) {
    console.log(`[MESSAGE-SCHEDULER] ${msg.id}: már lejátszva (más tick/node) – skip`);
    return;
  }

  // A célzást SZÁNDÉKOSAN itt, a lejátszás pillanatában oldjuk fel: az "ALL"
  // és az "ORG_UNIT" célzás az online eszközökre szűr, ami az ütemezés
  // időpontjában még nem ismert.
  const targetIds    = await resolveTargetDeviceIds(msg.tenantId, msg.targetType, msg.targetId);
  const candidateIds = await getCandidateDeviceIds(msg.tenantId, targetIds);

  await dispatchMessageNow({
    tenantId:      msg.tenantId,
    messageId:     msg.id,
    commandPrefix: "sched",
    fileUrl:       msg.fileUrl,
    title:         msg.title ?? "Üzenet",
    text:          msg.text,
    candidateIds,
  });
}

async function tick(): Promise<void> {
  const now     = new Date();
  const horizon = new Date(now.getTime() + LOOKAHEAD_MS);

  try {
    const due = await prisma.message.findMany({
      where: {
        playedAt:    null,
        scheduledAt: {
          gte: new Date(now.getTime() - STALE_THRESHOLD_MS),
          lte: horizon,
        },
      },
      select: {
        id: true, tenantId: true, title: true, text: true, fileUrl: true,
        targetType: true, targetId: true, scheduledAt: true,
      },
    });

    // Elavult, régen esedékes üzenetek lezárása (nem játsszuk le utólag).
    const stale = await prisma.message.updateMany({
      where: {
        playedAt:    null,
        scheduledAt: { not: null, lt: new Date(now.getTime() - STALE_THRESHOLD_MS) },
      },
      data: { playedAt: new Date() },
    });
    if (stale.count > 0) {
      console.warn(`[MESSAGE-SCHEDULER] ${stale.count} elavult időzített üzenet lezárva lejátszás nélkül`);
    }

    for (const msg of due) {
      if (_pendingTimeouts.has(msg.id)) continue;
      if (!isOwnedByThisNode(msg.tenantId)) continue;

      const waitMs = Math.max(0, (msg.scheduledAt as Date).getTime() - Date.now());
      console.log(
        `[MESSAGE-SCHEDULER] Ütemezve: ${msg.id} (tenant=${msg.tenantId}) ` +
        `wait=${Math.round(waitMs / 1000)}s`
      );

      _pendingTimeouts.set(
        msg.id,
        setTimeout(() => {
          void fire(msg).catch(e =>
            console.error(`[MESSAGE-SCHEDULER] fire hiba (${msg.id}):`, e)
          );
        }, waitMs)
      );
    }
  } catch (e) {
    console.error("[MESSAGE-SCHEDULER] tick hiba:", e);
  }
}

/** Egy még el nem küldött időzített üzenet visszavonása (pl. DELETE /messages/:id). */
export function cancelScheduledMessage(messageId: string): void {
  const t = _pendingTimeouts.get(messageId);
  if (t) {
    clearTimeout(t);
    _pendingTimeouts.delete(messageId);
    console.log(`[MESSAGE-SCHEDULER] Ütemezés visszavonva: ${messageId}`);
  }
}

export function startMessageScheduler(): void {
  if (_running) return;
  _running = true;
  console.log(
    `[MESSAGE-SCHEDULER] Indult (tick: ${TICK_INTERVAL_MS}ms, lookahead: ${LOOKAHEAD_MS}ms, stale: ${STALE_THRESHOLD_MS}ms)`
  );
  void tick();
  setInterval(() => void tick(), TICK_INTERVAL_MS);
}
