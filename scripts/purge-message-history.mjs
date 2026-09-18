// scripts/purge-message-history.mjs
//
// EGYSZERI TAKARÍTÁS: a felhalmozódott üzenet-előzmény eltávolítása.
//
//   node scripts/purge-message-history.mjs            # csak jelent
//   node scripts/purge-message-history.mjs --apply    # tényleges törlés
//
// MIÉRT: az üzenetek hangja egyszer hangzik el, utána nincs rá szükség. A
// "Korábbi üzenetek" felület megszűnt, tehát a régi sorok nem is érhetők el.
// A teszt-visszatöltésben 115 Message sor és 568 hangfájl (162 MB) gyűlt
// össze, aminek ~80%-ára már EGYETLEN sor sem hivatkozott.
//
// ⚠️ EZ VISSZAFORDÍTHATATLAN. Éles futtatás előtt legyen adatbázis-mentés.
//
// AMIT MEGTART:
//   • minden JÖVŐBELI IDŐZÍTÉSŰ üzenetet (playedAt IS NULL és scheduledAt > most)
//     – azok még nem hangzottak el, a hangjuk kell,
//   • az `audio/bells/` és `audio/intros/` alkönyvtárakat érintetlenül
//     (csengetőhangok és üzenet-introk – nem ehhez a takarításhoz tartoznak).
//
// A folyamatos karbantartást ezután a message.janitor.ts végzi.

import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const AUDIO_DIR = path.join(process.cwd(), "audio");
const AUDIO_EXT_RE = /\.(opus|mp3|wav|ogg|m4a|aac|flac|webm)$/i;

const nameOf = (url) => {
  if (!url) return null;
  try { return decodeURIComponent(String(url).split("/").pop().split("?")[0]) || null; }
  catch { return null; }
};

console.log(APPLY ? "═══ ÉLES TÖRLÉS ═══" : "═══ SZÁRAZ FUTÁS (--apply az éleshez) ═══");

const now = new Date();
const keep = await prisma.message.findMany({
  where: { playedAt: null, scheduledAt: { gt: now } },
  select: { id: true, fileUrl: true, scheduledAt: true },
});
const keepIds    = new Set(keep.map(m => m.id));
const keepFiles  = new Set(keep.map(m => nameOf(m.fileUrl)).filter(Boolean));

const all = await prisma.message.count();
console.log(`\nMessage sorok: ${all} összesen, ebből MEGTARTVA ${keep.length} (jövőbeli időzítés)`);
for (const m of keep) console.log(`   ↳ marad: ${m.id.slice(0, 8)}… (${m.scheduledAt.toISOString()})`);

// ── Fájlok ──────────────────────────────────────────────────────────────────
let entries = [];
try { entries = fs.readdirSync(AUDIO_DIR, { withFileTypes: true }); } catch {}

/*
 * RENDSZER-HANGOK, AMIK NEM ÜZENET-ELŐZMÉNYEK.
 *
 * Az `audio/` gyökérben nem csak üzenet-hangok vannak: a `dingdong.wav` az
 * üzenetek elé kevert figyelemfelkeltő hang, amit a tts.service.ts állít elő
 * (és a `.opus`/`.mp3` forrása is itt állhat). Egyetlen Message sem hivatkozik
 * rá, tehát a "nincs rá hivatkozás → törlöm" szabály kidobná.
 *
 * Helyreállna magától a következő TTS-nél az assets/bells/dingdong.opus-ból,
 * de ha az a forrás valaha hiányzik, az intro NÉMÁN maradna el
 * ("nincs dingdong forrás – üzenet-előtti hang kimarad"). Nem hagyatkozunk
 * a tartalék-láncra ott, ahol egy névlista is elég.
 */
const PROTECTED_BASENAMES = new Set(["dingdong"]);
const isProtected = (name) =>
  PROTECTED_BASENAMES.has(name.replace(/\.[^.]+$/, "").toLowerCase());

let delFiles = 0, keptFiles = 0, bytes = 0, protectedFiles = 0, failed = 0;
for (const e of entries) {
  if (!e.isFile()) continue;                    // alkönyvtárak érintetlenül
  if (!AUDIO_EXT_RE.test(e.name)) continue;
  if (isProtected(e.name)) { protectedFiles++; continue; }
  if (keepFiles.has(e.name)) { keptFiles++; continue; }
  const p = path.join(AUDIO_DIR, e.name);
  let size = 0;
  try { size = fs.statSync(p).size; } catch {}
  /*
   * CSAK A TÉNYLEGESEN TÖRÖLT FÁJLT SZÁMOLJUK.
   *
   * A számláló korábban az unlink ELŐTT nőtt, a hibát pedig csak egy warning
   * jelezte – az összegzés így 112 törölt fájlt jelentett, miközben EGY SEM
   * törlődött (a scriptet `balazs` futtatta, a fájlok `deploy` tulajdonában
   * vannak → EACCES). A DB-sorok viszont eltűntek, tehát a kimenet pont
   * abban a helyzetben hazudott, ahol árva fájlok maradtak hátra.
   */
  if (APPLY) {
    try {
      fs.unlinkSync(p);
      delFiles++; bytes += size;
    } catch (err) {
      failed++;
      console.warn(`  ⚠ ${e.name}: ${err.message}`);
    }
  } else {
    delFiles++; bytes += size;
  }
}

// ── DB-sorok ────────────────────────────────────────────────────────────────
let delRows = 0;
if (APPLY) {
  const r = await prisma.message.deleteMany({ where: { id: { notIn: [...keepIds] } } });
  delRows = r.count;
} else {
  delRows = all - keep.length;
}

console.log(`\n═══ ÖSSZEGZÉS ═══`);
console.log(`  törölt hangfájl:   ${delFiles}  (${(bytes / 1048576).toFixed(1)} MB)`);
console.log(`  megtartott fájl:   ${keptFiles}`);
console.log(`  védett rendszerhang: ${protectedFiles}`);
if (failed > 0) console.log(`  ⚠ NEM törölhető:    ${failed}  (jogosultság? futtasd: sudo -u deploy …)`);
console.log(`  törölt Message:    ${delRows}`);
console.log(`  megtartott Message:${keep.length}`);
if (!APPLY) console.log(`\n  Semmi nem változott. Éles: --apply`);

await prisma.$disconnect();
