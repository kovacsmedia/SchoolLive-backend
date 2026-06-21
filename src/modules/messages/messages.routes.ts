// src/modules/messages/messages.routes.ts

import { Router, Request, Response } from "express";
import { prisma }          from "../../prisma/client";
import { authJwt }         from "../../middleware/authJwt";
import { requireTenant }   from "../../middleware/tenant";
import { generateTTS, NORMALIZE_COMPRESS_FILTER } from "../../services/tts.service";
import { resolveIntroSoundPath } from "../bells/bells.routes";
import { stripAccents }    from "../../utils/text";
import { SyncEngine }      from "../../sync/SyncEngine";
import { SnapcastService } from "../snapcast/snapcast.service";
import { randomUUID }      from "crypto";
import { execFileSync }    from "child_process";
import multer              from "multer";
import path                from "path";
import fs                  from "fs";

const router = Router();

const AUDIO_DIR = path.join(process.cwd(), "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// Hangfelvétel feldolgozása:
//   1. Intro hang (default dingdong vagy a user által választott MESSAGE_INTRO)
//      elejére fűzése.
//   2. Acompressor + loudnorm filter chain: a halkabb beszéd kiemelve, a
//      kicsapódó csúcsok lefogva, végül EBU R128 normalize.
//
// Az `introSoundPath` opcionális – ha null, a default `audio/dingdong.wav`-ot
// használjuk, vagy ha az sincs, csak normalizálunk intro nélkül.
async function processRecording(
  inputPath: string,
  introSoundPath?: string | null,
): Promise<string> {
  const hash         = randomUUID().slice(0, 8);
  const concatWav    = path.join(AUDIO_DIR, `rec_concat_${hash}.wav`);
  // Opus kimenet – a snapserver natívan fogadja, kis fájlméret.
  const finalOpus    = path.join(AUDIO_DIR, `rec_${hash}.opus`);
  const defaultDing  = path.join(AUDIO_DIR, "dingdong.wav");

  const introPath = introSoundPath && fs.existsSync(introSoundPath)
    ? introSoundPath
    : (fs.existsSync(defaultDing) ? defaultDing : null);

  // 1. Eredeti webm-et 48000 mono WAV-ra konvertáljuk (közös formátum a
  //    kompresszor-pipeline elé). A böngésző MediaRecorder általában 48 kHz
  //    stereo Opus-t küld, így a downsample-t kihagyjuk – a beszéd tisztább
  //    marad (sziszegő mássalhangzók, "s", "sz", "c" élesebbek), és a végső
  //    libopus encode (48 kbps voip) is 48 kHz-en megy → nincs felesleges
  //    re-sample. A TTS-ág a `tts.service.ts`-ben Piper natív 22050 Hz-en
  //    marad, mert a Piper modell amúgy sem produkál többet.
  const rawWav = path.join(AUDIO_DIR, `rec_raw_${hash}.wav`);

  try {
    execFileSync("ffmpeg", [
      "-y", "-i", inputPath,
      "-ar", "48000", "-ac", "1",
      rawWav,
    ]);

    // 2. Ha van intro → concat FILTER-rel fűzzük össze (NEM demuxer-rel!).
    //
    // A concat demuxer azonos formátumú streamet vár, és csendben dobja
    // a második inputot, ha eltér – ez okozta a "csak intro szól, üzenet
    // nem" bug-ot, amikor a user nem-default MESSAGE_INTRO fájlt választott.
    // A filter változat auto-resample-eli mindkét streamet 48000 mono-ra,
    // és minden intro-formátummal (MP3/OGG/M4A/stereo/44.1kHz) működik.
    let preFilterWav: string;
    if (introPath) {
      execFileSync("ffmpeg", [
        "-y",
        "-i", introPath,
        "-i", rawWav,
        "-filter_complex",
          "[0:a]aresample=48000,aformat=channel_layouts=mono[a0];" +
          "[1:a]aresample=48000,aformat=channel_layouts=mono[a1];" +
          "[a0][a1]concat=n=2:v=0:a=1[out]",
        "-map", "[out]",
        "-ar", "48000", "-ac", "1",
        concatWav,
      ]);
      fs.unlinkSync(rawWav);
      preFilterWav = concatWav;
    } else {
      preFilterWav = rawWav;
    }

    // 3. Normalize + compressor + brick-wall limiter filter chain →
    //    libopus encode (48 kbps voip)
    execFileSync("ffmpeg", [
      "-y", "-i", preFilterWav,
      "-af", NORMALIZE_COMPRESS_FILTER,
      "-c:a", "libopus", "-b:a", "48k", "-application", "voip",
      "-ar", "48000", "-ac", "1",
      finalOpus,
    ]);
    try { fs.unlinkSync(preFilterWav); } catch {}

    // Eredeti webm törlése
    try { fs.unlinkSync(inputPath); } catch {}
    return finalOpus;

  } catch (err) {
    // Cleanup
    for (const f of [concatWav, rawWav]) { try { fs.unlinkSync(f); } catch {} }
    throw err;
  }
}

// Multer – hangfelvétel feltöltéshez
const audioUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, AUDIO_DIR),
    filename:    (_req, _file, cb) => cb(null, `rec_${randomUUID()}.webm`),
  }),
  limits:     { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) {
      cb(null, true);
    } else {
      cb(new Error("Only audio files allowed"));
    }
  },
});

function tenantId(req: Request): string { return (req as any).tenantId as string; }
function userId(req: Request):   string { return (req as any).user?.sub as string; }

async function resolveDeviceIds(
  tid: string, targetType: string, targetId?: string
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
      where:  { tenantId: tid, orgUnitId: targetId, online: true },
      select: { id: true },
    })).map(d => d.id);
  }
  return [];
}

async function getCandidateIds(tid: string, targetIds: string[] | null): Promise<string[]> {
  if (targetIds === null) {
    return (await prisma.device.findMany({
      where:  { tenantId: tid, online: true },
      select: { id: true },
    })).map(d => d.id);
  }
  return targetIds;
}

// GET /messages
router.get("/", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid   = tenantId(req);
    const page  = Math.max(1, parseInt(String(req.query.page  ?? "1"),  10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10)));
    const skip  = (page - 1) * limit;
    const where: any = { tenantId: tid };
    if (req.query.type) where.type = req.query.type;
    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where, orderBy: { createdAt: "desc" }, skip, take: limit,
        select: {
          id: true, title: true, text: true, type: true, voice: true,
          fileUrl: true, targetType: true, targetId: true,
          scheduledAt: true, playedAt: true, createdAt: true,
          createdBy: { select: { id: true, displayName: true, email: true } },
        },
      }),
      prisma.message.count({ where }),
    ]);
    return res.json({ ok: true, messages, total, page, limit });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to fetch messages" }); }
});

// GET /messages/templates
router.get("/templates", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const templates = await prisma.messageTemplate.findMany({
      where:   { tenantId: tenantId(req), userId: userId(req) },
      orderBy: { createdAt: "desc" },
      select:  { id: true, name: true, text: true, voice: true, createdAt: true },
    });
    return res.json({ ok: true, templates });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to fetch templates" }); }
});

// POST /messages/templates
router.post("/templates", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const { name, text, voice = "anna" } = req.body;
    if (!name || !text) return res.status(400).json({ error: "name and text are required" });
    const template = await prisma.messageTemplate.create({
      data: { name, text, voice,
        tenant: { connect: { id: tenantId(req) } },
        user:   { connect: { id: userId(req) } },
      },
    });
    return res.status(201).json({ ok: true, template });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to save template" }); }
});

// DELETE /messages/templates/:id
router.delete("/templates/:id", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    await prisma.messageTemplate.deleteMany({
      where: { id, tenantId: tenantId(req), userId: userId(req) },
    });
    return res.json({ ok: true });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to delete template" }); }
});

// POST /messages – TTS üzenet küldése
router.post("/", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid = tenantId(req);
    const uid = userId(req);
    const { text, voice = "anna", targetType, targetId, scheduledAt, preBellSoundId } = req.body;

    if (!text?.trim())  return res.status(400).json({ error: "Text is required" });
    if (!targetType)    return res.status(400).json({ error: "targetType is required" });

    // Opcionális üzenet-előtti intro hang (BellSoundFile, kind=MESSAGE_INTRO).
    // Ha nincs/érvénytelen → null, a TTS service a default dingdong-ra esik vissza.
    const introPath = (typeof preBellSoundId === "string" && preBellSoundId.trim())
      ? await resolveIntroSoundPath(tid, preBellSoundId.trim())
      : null;

    const { filename, durationMs } = await generateTTS(text.trim(), voice, introPath);
    const fileUrl       = `${process.env.BASE_URL ?? "https://api.schoollive.hu"}/audio/${filename}`;
    const scheduledTime = scheduledAt ? new Date(scheduledAt) : null;
    const isImmediate   = !scheduledTime || scheduledTime <= new Date();
    // Title: a TTS forrásszöveg első 200 karaktere, ÉKEZETESEN.
    // Korábban `stripAccents(... 64)` volt, mert egy régi fájlnév-jellegű
    // konvencióhoz volt kalibrálva. Mivel a `title` a HUD-overlay-en jelenik
    // meg (NOW_PLAYING_INFO broadcast), a stripped 64-karakteres változat
    // egyszerű forrás-csere után felülírta a kliens-oldali PLAY-helyzetben
    // mutatott teljes ékezetes szöveget. A Message DB-mező továbbra is külön
    // tárolódik (text), a title csak rövid kontextus a HUD-on.
    const title         = text.trim().substring(0, 200);

    const message = await prisma.message.create({
      data: {
        tenantId: tid, createdById: uid, type: "TTS",
        title, text: text.trim(),
        voice, fileUrl, targetType, targetId: targetId ?? null, scheduledAt: scheduledTime,
      },
    });

    const targetIds    = await resolveDeviceIds(tid, targetType, targetId);
    if (targetIds !== null && targetIds.length === 0) return res.status(201).json({ ok: true, message });
    const candidateIds = await getCandidateIds(tid, targetIds);

    if (isImmediate) {
      const snapOnline = await SnapcastService.isSnapserverOnline(tid);
      if (snapOnline) {
        await SnapcastService.play({
          type:               "TTS",
          source:             { type: "url", url: fileUrl },
          tenantId:           tid,
          title,
          text:               text.trim(),
          deviceIdsToUnmute:  candidateIds,
        });
      }
      const onlineIds  = candidateIds.filter(id => SyncEngine.isDeviceOnline(id));
      const offlineIds = candidateIds.filter(id => !SyncEngine.isDeviceOnline(id));
      if (onlineIds.length > 0) {
        SyncEngine.dispatchSync({
          tenantId: tid, commandId: `msg-${message.id}`, action: "TTS",
          url: fileUrl, text: text.trim(), title, durationMs: durationMs ?? undefined,
          targetDeviceIds: candidateIds,
          snapcastActive: snapOnline,
        }).catch(e => console.error("[MESSAGES] SyncEngine hiba:", e));
      }
      if (offlineIds.length > 0) {
        await prisma.deviceCommand.createMany({
          data: offlineIds.map(deviceId => ({
            tenantId: tid, deviceId, messageId: message.id, status: "QUEUED" as const,
            payload: { action: "TTS", url: fileUrl, text: text.trim(), title, scheduledAt: null },
          })),
        });
      }
    } else {
      const scheduledCandidates = targetIds === null
        ? (await prisma.device.findMany({ where: { tenantId: tid }, select: { id: true } })).map(d => d.id)
        : targetIds;
      await prisma.deviceCommand.createMany({
        data: scheduledCandidates.map(deviceId => ({
          tenantId: tid, deviceId, messageId: message.id, status: "QUEUED" as const,
          payload: { action: "TTS", url: fileUrl, text: text.trim(), title, scheduledAt: scheduledTime?.toISOString() ?? null },
        })),
      });
    }

    return res.status(201).json({ ok: true, message });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to create message" }); }
});

// POST /messages/audio – Hangfelvétel feltöltése és lejátszása
router.post("/audio", authJwt, requireTenant, audioUpload.single("audio"), async (req: Request, res: Response) => {
  try {
    const tid = tenantId(req);
    const uid = userId(req);

    if (!req.file) return res.status(400).json({ error: "Hangfájl megadása kötelező." });

    const { targetType = "ALL", targetId, scheduledAt, preBellSoundId } = req.body ?? {};

    // Opcionális intro hang (lásd /messages POST hasonló logikát).
    const introPath = (typeof preBellSoundId === "string" && preBellSoundId.trim())
      ? await resolveIntroSoundPath(tid, preBellSoundId.trim())
      : null;

    // Feldolgozás: intro prepend + normalize + compressor
    let processedFilename = req.file.filename;
    try {
      const processedPath = await processRecording(req.file.path, introPath);
      processedFilename = path.basename(processedPath);
      console.log(`[MESSAGES] Hangfelvétel feldolgozva: ${processedFilename}`);
    } catch (procErr) {
      console.error("[MESSAGES] Feldolgozás hiba (eredeti fájl használva):", procErr);
    }
    const fileUrl       = `${process.env.BASE_URL ?? "https://api.schoollive.hu"}/audio/${processedFilename}`;
    const scheduledTime = scheduledAt ? new Date(scheduledAt) : null;
    const isImmediate   = !scheduledTime || scheduledTime <= new Date();
    const title         = stripAccents("Hangfelvétel");

    // TTS típust használunk – a hangfelvétel ugyanolyan lejátszási logikát igényel
    const message = await prisma.message.create({
      data: {
        tenantId: tid, createdById: uid,
        type: "TTS",   // RECORDING enum nem létezik a sémában
        title, text: null, voice: null,
        fileUrl, targetType, targetId: targetId ?? null, scheduledAt: scheduledTime,
      },
    });

    const targetIds    = await resolveDeviceIds(tid, targetType, targetId);
    if (targetIds !== null && targetIds.length === 0) return res.status(201).json({ ok: true, message });
    const candidateIds = await getCandidateIds(tid, targetIds);

    if (isImmediate) {
      const snapOnline = await SnapcastService.isSnapserverOnline(tid);
      if (snapOnline) {
        await SnapcastService.play({
          type:               "TTS",
          source:             { type: "url", url: fileUrl },
          tenantId:           tid,
          title,
          deviceIdsToUnmute:  candidateIds,
        });
      }
      const onlineIds  = candidateIds.filter(id => SyncEngine.isDeviceOnline(id));
      const offlineIds = candidateIds.filter(id => !SyncEngine.isDeviceOnline(id));
      if (onlineIds.length > 0) {
        SyncEngine.dispatchSync({
          tenantId: tid, commandId: `rec-${message.id}`, action: "TTS",
          url: fileUrl, title,
          targetDeviceIds: candidateIds,
          snapcastActive: snapOnline,
        }).catch(e => console.error("[MESSAGES] SyncEngine hiba:", e));
      }
      if (offlineIds.length > 0) {
        await prisma.deviceCommand.createMany({
          data: offlineIds.map(deviceId => ({
            tenantId: tid, deviceId, messageId: message.id, status: "QUEUED" as const,
            payload: { action: "TTS", url: fileUrl, title, scheduledAt: null },
          })),
        });
      }
    } else {
      const scheduledCandidates = targetIds === null
        ? (await prisma.device.findMany({ where: { tenantId: tid }, select: { id: true } })).map(d => d.id)
        : targetIds;
      await prisma.deviceCommand.createMany({
        data: scheduledCandidates.map(deviceId => ({
          tenantId: tid, deviceId, messageId: message.id, status: "QUEUED" as const,
          payload: { action: "TTS", url: fileUrl, title, scheduledAt: scheduledTime?.toISOString() ?? null },
        })),
      });
    }

    console.log(`[MESSAGES] Hangfelvétel elküldve: ${processedFilename} | tenant: ${tid}`);
    return res.status(201).json({ ok: true, message });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to send recording" }); }
});

// POST /messages/play-url
router.post("/play-url", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid = tenantId(req);
    const { url, title = "Iskolarádió", targetType = "ALL", targetId } = req.body;
    if (!url?.trim()) return res.status(400).json({ error: "url is required" });
    const targetIds    = await resolveDeviceIds(tid, targetType, targetId);
    const candidateIds = await getCandidateIds(tid, targetIds);
    const snapOnline   = await SnapcastService.isSnapserverOnline(tid);
    if (snapOnline) {
      await SnapcastService.play({
        type:               "RADIO",
        source:             { type: "stream", url },
        tenantId:           tid,
        title,
        deviceIdsToUnmute:  candidateIds,
        persistent:         true,
      });
    }
    const onlineIds = candidateIds.filter(id => SyncEngine.isDeviceOnline(id));
    if (onlineIds.length > 0) {
      await SyncEngine.dispatchSync({
        tenantId: tid, commandId: randomUUID(), action: "PLAY_URL", kind: "MESSAGE", url, title,
        durationMs: undefined, snapcastActive: snapOnline,
        targetDeviceIds: candidateIds,
      });
    }
    return res.json({ ok: true, snapcastActive: snapOnline });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to start stream" }); }
});

// POST /messages/stop
router.post("/stop", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid = tenantId(req);
    await SnapcastService.stop(tid);
    SyncEngine.broadcastImmediate(tid, { action: "STOP_PLAYBACK", commandId: randomUUID() });
    return res.json({ ok: true });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to stop playback" }); }
});

// POST /messages/:id/replay
// Egy korábbi üzenet újra-bemondatása. A tárolt fileUrl-t újra elindítjuk
// az aktuális (vagy megadott) cél eszközökre. FONTOS: NEM hozunk létre új
// renderet, NEM prepend-eljük a bell hangot újra – a fájl már tartalmazza.
// Az eredeti Message rekord `playedAt` mezőjét frissítjük az új lejátszás
// időbélyegével (audit szempontjából a "legutóbbi lejátszás" látszik).
router.post("/:id/replay", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid = tenantId(req);
    const id  = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const original = await prisma.message.findFirst({
      where:  { id, tenantId: tid },
      select: { id: true, title: true, text: true, fileUrl: true, targetType: true, targetId: true },
    });
    if (!original) return res.status(404).json({ error: "Message not found" });
    if (!original.fileUrl) {
      return res.status(400).json({ error: "Az üzenetnek nincs eltárolt fájlja (replay nem lehetséges)" });
    }

    // A body-ból kérhető új cél/időpont, különben az eredeti üzenetéé.
    const targetType: string =
      (req.body?.targetType as string) || original.targetType || "ALL";
    const targetId: string | undefined =
      typeof req.body?.targetId === "string" ? req.body.targetId : (original.targetId ?? undefined);
    const scheduledTime: Date | null =
      req.body?.scheduledAt ? new Date(req.body.scheduledAt) : null;
    const isImmediate = !scheduledTime || scheduledTime <= new Date();

    const targetIds    = await resolveDeviceIds(tid, targetType, targetId);
    if (targetIds !== null && targetIds.length === 0) {
      return res.status(200).json({ ok: true, replayed: false, reason: "No target devices" });
    }
    const candidateIds = await getCandidateIds(tid, targetIds);

    if (isImmediate) {
      const snapOnline = await SnapcastService.isSnapserverOnline(tid);
      if (snapOnline) {
        await SnapcastService.play({
          type:              "TTS",
          source:            { type: "url", url: original.fileUrl },
          tenantId:          tid,
          title:             original.title ?? "Üzenet",
          text:              original.text  ?? undefined,
          deviceIdsToUnmute: candidateIds,
        });
      }
      const onlineIds  = candidateIds.filter(d => SyncEngine.isDeviceOnline(d));
      const offlineIds = candidateIds.filter(d => !SyncEngine.isDeviceOnline(d));

      if (onlineIds.length > 0) {
        SyncEngine.dispatchSync({
          tenantId:        tid,
          commandId:       `replay-${original.id}-${Date.now()}`,
          action:          "TTS",
          url:             original.fileUrl,
          text:            original.text ?? undefined,
          title:           original.title ?? "Üzenet",
          targetDeviceIds: candidateIds,
          snapcastActive:  snapOnline,
        }).catch(e => console.error("[MESSAGES/replay] SyncEngine hiba:", e));
      }
      if (offlineIds.length > 0) {
        await prisma.deviceCommand.createMany({
          data: offlineIds.map(deviceId => ({
            tenantId: tid, deviceId, messageId: original.id, status: "QUEUED" as const,
            payload: { action: "TTS", url: original.fileUrl, text: original.text ?? undefined,
                       title: original.title ?? "Üzenet", scheduledAt: null },
          })),
        });
      }
      // Eredeti üzenet `playedAt` frissítése
      await prisma.message.update({ where: { id: original.id }, data: { playedAt: new Date() } });
    } else {
      const scheduledCandidates = targetIds === null
        ? (await prisma.device.findMany({ where: { tenantId: tid }, select: { id: true } })).map(d => d.id)
        : targetIds;
      await prisma.deviceCommand.createMany({
        data: scheduledCandidates.map(deviceId => ({
          tenantId: tid, deviceId, messageId: original.id, status: "QUEUED" as const,
          payload: { action: "TTS", url: original.fileUrl, text: original.text ?? undefined,
                     title: original.title ?? "Üzenet",
                     scheduledAt: scheduledTime?.toISOString() ?? null },
        })),
      });
    }

    return res.json({ ok: true, replayed: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to replay message" });
  }
});

// GET /messages/:id
router.get("/:id", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const message = await prisma.message.findFirst({
      where: { id, tenantId: tenantId(req) },
      include: {
        createdBy: { select: { id: true, displayName: true, email: true } },
        commands:  { select: { id: true, deviceId: true, status: true, queuedAt: true, ackedAt: true } },
      },
    });
    if (!message) return res.status(404).json({ error: "Message not found" });
    return res.json({ ok: true, message });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to fetch message" }); }
});

// DELETE /messages/:id
router.delete("/:id", authJwt, requireTenant, async (req: Request, res: Response) => {
  try {
    const tid  = tenantId(req);
    const user = (req as any).user;
    const id   = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (user?.role !== "SUPER_ADMIN" && user?.role !== "TENANT_ADMIN") return res.status(403).json({ error: "Forbidden" });
    await prisma.message.delete({ where: { id, tenantId: tid } });
    return res.json({ ok: true });
  } catch (err) { console.error(err); return res.status(500).json({ error: "Failed to delete message" }); }
});

export default router;