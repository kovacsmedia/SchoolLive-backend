// src/modules/messages/message.janitor.ts
//
// ÜZENET-TAKARÍTÓ.
//
// Az üzenetek hangja egyszer hangzik el, utána nincs rá szükség. Korábban
// minden legenerált fájl a lemezen maradt: 568 fájl / 162 MB gyűlt össze,
// aminek ~80%-ára már EGYETLEN üzenet sem hivatkozott (TTS-előnézetek,
// félbehagyott felvételek, törölt üzenetek hangjai).
//
// Három dolgot takarít, egymástól függetlenül:
//
//   1. LEJÁTSZOTT ÜZENET HANGJA – a bemondás után FILE_GRACE_MIN perccel.
//   2. RÉGI ÜZENET-SOR – ROW_RETENTION_H óra után a DB-sor is megy.
//   3. ÁRVA FÁJL – amire egyetlen Message sem hivatkozik.
//
// MIÉRT NEM AZONNAL A LEJÁTSZÁS UTÁN: a `playedAt` a bemondás KEZDETÉT jelöli
// (ld. message.scheduler.ts claimMessage). Abban a pillanatban törölve a
// fájlt kirántanánk a mixer ffmpeg-je alól, ami épp olvassa – a bemondás
// félbeszakadna. A türelmi idő ezt zárja ki.
//
// ⚠️ CSAK AZ `audio/` GYÖKERET ÉRINTI. Az `audio/bells/` és `audio/intros/`
// alkönyvtárak a csengetőhangoké és az üzenet-introké – azokhoz SOSEM nyúl.
// Az `audio/` gyökérben kizárólag üzenet-hang keletkezik.

import fs from "fs";
import path from "path";
import { prisma } from "../../prisma/client";

const AUDIO_DIR = path.join(process.cwd(), "audio");

/** Ennyivel a bemondás KEZDETE után törölhető a hangfájl. */
const FILE_GRACE_MIN = 15;

/** Ennyi idő után a Message sor is törlődik. */
const ROW_RETENTION_H = 24;

/**
 * Egy árva fájlt csak ennyi idő után törlünk.
 *
 * Védelem a versenyhelyzet ellen: egy éppen most legenerált hang néhány
 * másodpercig még nincs egyetlen Message sorban sem (előbb a fájl készül el,
 * utána jön a DB-írás). Türelmi idő nélkül a takarító pont azt törölné, ami
 * most készült el.
 */
const ORPHAN_MIN_AGE_H = 2;

const TICK_MS = 30 * 60 * 1000;

const AUDIO_EXT_RE = /\.(opus|mp3|wav|ogg|m4a|aac|flac|webm)$/i;

let _timer: ReturnType<typeof setInterval> | null = null;

function fileNameOf(fileUrl: string | null): string | null {
  if (!fileUrl) return null;
  try {
    const last = String(fileUrl).split("/").pop() ?? "";
    const name = decodeURIComponent(last.split("?")[0]);
    return name || null;
  } catch { return null; }
}

function removeRootFile(name: string): boolean {
  // Biztonsági kapu: se útvonal-elem, se alkönyvtár nem kerülhet ide.
  if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) return false;
  const p = path.join(AUDIO_DIR, name);
  if (path.dirname(p) !== AUDIO_DIR) return false;
  try {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return false;
    fs.unlinkSync(p);
    return true;
  } catch (e: any) {
    console.warn(`[MSG-JANITOR] nem sikerült törölni: ${name}: ${e.message}`);
    return false;
  }
}

export async function runMessageJanitor(): Promise<void> {
  const now = Date.now();
  let files = 0, rows = 0, orphans = 0;

  try {
    // ── 1. Lejátszott üzenetek hangja ───────────────────────────────────────
    const played = await prisma.message.findMany({
      where: {
        fileUrl:  { not: null },
        playedAt: { not: null, lt: new Date(now - FILE_GRACE_MIN * 60_000) },
      },
      select: { id: true, fileUrl: true },
    });

    for (const m of played) {
      const name = fileNameOf(m.fileUrl);
      if (name && removeRootFile(name)) files++;
      // A `fileUrl` nullázása akkor is helyes, ha a fájl már nem volt meg:
      // a sor így nem mutat nem létező fájlra.
      await prisma.message.update({ where: { id: m.id }, data: { fileUrl: null } });
    }

    // ── 2. Régi üzenet-sorok ────────────────────────────────────────────────
    // CSAK a már lejátszottak. Egy jövőbeli időzítésű üzenet `playedAt`-je
    // null, tehát ide sosem kerül be – az ütemezés nem sérülhet.
    const delRows = await prisma.message.deleteMany({
      where: { playedAt: { not: null, lt: new Date(now - ROW_RETENTION_H * 3_600_000) } },
    });
    rows = delRows.count;

    // ── 3. Árva fájlok ──────────────────────────────────────────────────────
    const referenced = new Set<string>();
    for (const m of await prisma.message.findMany({
      where: { fileUrl: { not: null } }, select: { fileUrl: true },
    })) {
      const n = fileNameOf(m.fileUrl);
      if (n) referenced.add(n);
    }

    const cutoff = now - ORPHAN_MIN_AGE_H * 3_600_000;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(AUDIO_DIR, { withFileTypes: true }); } catch { entries = []; }

    for (const e of entries) {
      if (!e.isFile()) continue;                       // alkönyvtárak kimaradnak
      if (!AUDIO_EXT_RE.test(e.name)) continue;
      if (referenced.has(e.name)) continue;
      let mtime = 0;
      try { mtime = fs.statSync(path.join(AUDIO_DIR, e.name)).mtimeMs; } catch { continue; }
      if (mtime > cutoff) continue;                    // túl friss, lehet épp készülő
      if (removeRootFile(e.name)) orphans++;
    }

    if (files || rows || orphans) {
      console.log(`[MSG-JANITOR] hangfájl: ${files} | üzenet-sor: ${rows} | árva fájl: ${orphans}`);
    }
  } catch (e: any) {
    console.error("[MSG-JANITOR] hiba:", e?.message ?? e);
  }
}

export function startMessageJanitor(): void {
  if (_timer) return;
  // Indulás után 2 perccel fut először: a bootolás egyéb munkáit ne zavarja.
  setTimeout(() => { void runMessageJanitor(); }, 2 * 60_000);
  _timer = setInterval(() => { void runMessageJanitor(); }, TICK_MS);
  console.log(
    `[MSG-JANITOR] Indult (tick: ${TICK_MS / 60000}p, hang törlése ${FILE_GRACE_MIN}p, ` +
    `sor törlése ${ROW_RETENTION_H}ó, árva ${ORPHAN_MIN_AGE_H}ó után)`
  );
}
