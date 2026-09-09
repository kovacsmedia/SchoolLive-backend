// src/modules/messages/message.dispatch.ts
//
// Egy üzenet TÉNYLEGES lejátszásra küldése.
//
// Jelenleg a message.scheduler.ts hívja (időzített üzenetek). A három
// azonnali útvonal (POST /messages, POST /messages/audio, POST
// /messages/:id/replay) SZÁNDÉKOSAN a saját, változatlan inline blokkját
// használja – az élő, bevált hot path-t nem írtuk át egy hibajavítás
// kedvéért. Ez a függvény pontosan azt a lépéssort ismétli, hogy egy
// időzített üzenet ugyanúgy viselkedjen, mintha abban a pillanatban
// nyomták volna meg a küldést. Ha később egységesítjük, ez a hely az
// egyetlen forrás.
//
// A sorrend szándékos és megegyezik az inline verzióval:
//   1. Snapcast job (ez a tényleges hang – a mixer keveri a tenant streamjébe)
//   2. SyncEngine PREPARE/PLAY az ONLINE eszközöknek (HUD + unmute-célzás)
//   3. DeviceCommand queue az OFFLINE eszközöknek (a kliens a köv.
//      csatlakozáskor pótolja)

import { prisma } from "../../prisma/client";
import { SyncEngine } from "../../sync/SyncEngine";
import { SnapcastService } from "../snapcast/snapcast.service";

// ── Cél-feloldás ────────────────────────────────────────────────────────────
//
// Korábban a messages.routes.ts privát függvényei voltak; azért kerültek ide,
// mert az időzített ág (message.scheduler.ts) is ezeket hívja – és FONTOS,
// hogy a LEJÁTSZÁS pillanatában fussanak le, ne a létrehozáskor: egy 2 órával
// későbbre időzített "ALL" célzású üzenetnél a "melyik eszköz van online"
// kérdésre csak akkor van értelmes válasz.

/** `null` = ALL (minden eszköz), egyébként a konkrét Device.id lista. */
export async function resolveTargetDeviceIds(
  tenantId: string, targetType: string, targetId?: string | null
): Promise<string[] | null> {
  if (targetType === "ALL") return null;
  if (targetType === "DEVICE" && targetId) return [targetId];
  if (targetType === "GROUP" && targetId) {
    return (await prisma.deviceGroupMember.findMany({
      where:  { groupId: targetId },
      select: { deviceId: true },
    })).map(m => m.deviceId);
  }
  if (targetType === "ORG_UNIT" && targetId) {
    return (await prisma.device.findMany({
      where:  { tenantId, orgUnitId: targetId, online: true },
      select: { id: true },
    })).map(d => d.id);
  }
  return [];
}

/** A `resolveTargetDeviceIds()` null-ját (ALL) feloldja a tenant online eszközeire. */
export async function getCandidateDeviceIds(
  tenantId: string, targetIds: string[] | null
): Promise<string[]> {
  if (targetIds === null) {
    return (await prisma.device.findMany({
      where:  { tenantId, online: true },
      select: { id: true },
    })).map(d => d.id);
  }
  return targetIds;
}

export type MessageDispatchParams = {
  tenantId: string;
  /** A Message.id – a DeviceCommand.messageId-hoz és a commandId prefixhez. */
  messageId: string;
  /** Egyedi WS commandId prefix: "msg" | "rec" | "replay" | "sched". */
  commandPrefix: string;
  fileUrl: string;
  title: string;
  text?: string | null;
  /** A célzott eszközök – `getCandidateIds()` eredménye (sosem null). */
  candidateIds: string[];
  durationMs?: number | null;
};

/**
 * Elindítja az üzenet lejátszását MOST. Nem dob: minden részlépés saját
 * hibakezeléssel megy, mert egy félresikerült ág (pl. offline snapserver)
 * nem akadályozhatja meg a többit.
 */
export async function dispatchMessageNow(p: MessageDispatchParams): Promise<void> {
  const { tenantId, messageId, commandPrefix, fileUrl, title, text, candidateIds, durationMs } = p;

  if (candidateIds.length === 0) {
    console.log(`[MESSAGE-DISPATCH] Nincs célzott eszköz: message=${messageId}`);
    return;
  }

  const snapOnline = await SnapcastService.isSnapserverOnline(tenantId);

  if (snapOnline) {
    try {
      await SnapcastService.play({
        type:              "TTS",
        source:            { type: "url", url: fileUrl },
        tenantId,
        title,
        text:              text ?? undefined,
        deviceIdsToUnmute: candidateIds,
      });
    } catch (e) {
      console.error(`[MESSAGE-DISPATCH] Snapcast play hiba (${messageId}):`, e);
    }
  }

  const onlineIds  = candidateIds.filter(id => SyncEngine.isDeviceOnline(id));
  const offlineIds = candidateIds.filter(id => !SyncEngine.isDeviceOnline(id));

  if (onlineIds.length > 0) {
    SyncEngine.dispatchSync({
      tenantId,
      commandId:       `${commandPrefix}-${messageId}`,
      action:          "TTS",
      url:             fileUrl,
      text:            text ?? undefined,
      title,
      durationMs:      durationMs ?? undefined,
      targetDeviceIds: candidateIds,
      snapcastActive:  snapOnline,
    }).catch(e => console.error(`[MESSAGE-DISPATCH] SyncEngine hiba (${messageId}):`, e));
  }

  if (offlineIds.length > 0) {
    try {
      await prisma.deviceCommand.createMany({
        data: offlineIds.map(deviceId => ({
          tenantId,
          deviceId,
          messageId,
          status:  "QUEUED" as const,
          payload: { action: "TTS", url: fileUrl, text: text ?? undefined, title, scheduledAt: null },
        })),
      });
    } catch (e) {
      console.error(`[MESSAGE-DISPATCH] DeviceCommand queue hiba (${messageId}):`, e);
    }
  }

  console.log(
    `[MESSAGE-DISPATCH] message=${messageId} tenant=${tenantId} snap=${snapOnline} ` +
    `online=${onlineIds.length} offline=${offlineIds.length}`
  );
}
