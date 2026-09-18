// scripts/migrate-audio-to-opus.mjs
//
// A meglévő hangállomány átállítása a rendszer EGYSÉGES formátumára:
// Opus 96 kbit/s, 48 kHz, sztereó (ld. src/utils/audio-format.ts).
//
// Használat:
//   node scripts/migrate-audio-to-opus.mjs            # SZÁRAZ futás (csak listáz)
//   node scripts/migrate-audio-to-opus.mjs --apply    # tényleges átkódolás
//
// A `.mjs` kiterjesztés SZÁNDÉKOS: a package.json-ben nincs `"type": "module"`.
//
// ═══════════════════════════════════════════════════════════════════════════
// A RÉGI FÁJLOKAT NEM TÖRLI.
//
// Az eredeti (jellemzően MP3) példányok a helyükön maradnak, mert a
// failsafe ezekből él: amíg van olyan eszköz, ami nem kapta meg az Opus-képes
// firmware-t, a `/bells/sync` neki a régi változatot kínálja. Csak akkor
// törölhetők, ha MINDEN eszköz frissült – erre külön lépés való, nem ez.
//
// Ezért a szkript többször is futtatható: ami már át van kódolva, azt
// kihagyja.
// ═══════════════════════════════════════════════════════════════════════════
//
// SORREND. Előbb a LEMEZ, utána az ADATBÁZIS. Ha a szkript a kettő között
// hal meg, a DB még a régi névre mutat – azt pedig a backend feloldója
// (bellSoundDiskPath → soundNameVariants) megtalálja az új kiterjesztéssel is.
// Fordított sorrendben egy megszakadt futás olyan DB-sorokat hagyna, amikhez
// nincs fájl: néma csengetés.

import { PrismaClient } from "@prisma/client";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);
const prisma = new PrismaClient();

const APPLY = process.argv.includes("--apply");

// Ezeknek egyeznie KELL a src/utils/audio-format.ts értékeivel. Külön írjuk,
// mert a szkript nem megy át a TypeScript-fordításon.
const AUDIO_EXT         = ".opus";
const AUDIO_BITRATE     = "128k";
const AUDIO_SAMPLE_RATE = "48000";
const AUDIO_CHANNELS    = "2";
const KEEP_MAX_KBPS     = 150;   // 128 * 1.17, ld. audio-format.ts
// Ennél rövidebb fájlnál a mért bitráta nem megbízható: az Ogg-fejléc (~1 kB)
// egy 1-2 másodperces hangnál 135-145 kbit/s-ot mutat, holott a hang 96k.
// Enélkül a szkript MINDEN futáson újrakódolta ugyanazt a 14 rövid fájlt,
// generációnként veszítve. Ld. utils/audio-format.ts BITRATE_TRUST_MIN_SEC.
const BITRATE_TRUST_MIN_SEC = 10;

const BELL_AUDIO_DIR  = path.join(process.cwd(), "audio", "bells");
const BELL_ASSET_DIR  = path.join(process.cwd(), "assets", "bells");
const MESSAGE_AUDIO_DIR = path.join(process.cwd(), "audio");
const INTRO_AUDIO_DIR  = path.join(process.cwd(), "audio", "intros");
const RADIO_UPLOAD_DIR = path.join(process.cwd(), "uploads", "radio");

let converted = 0, skipped = 0, failed = 0, dbUpdates = 0;

function withOpusExt(name) {
  return path.basename(name, path.extname(name)) + AUDIO_EXT;
}

async function probe(filePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet", "-select_streams", "a:0",
      "-show_entries", "stream=codec_name:format=bit_rate,duration",
      "-of", "default=noprint_wrappers=1:nokey=1", filePath,
    ], { timeout: 15000 });
    const lines = stdout.trim().split(/\r?\n/);
    const codec = (lines[0] ?? "").trim().toLowerCase();
    const bits  = parseInt((lines[1] ?? "").trim(), 10);
    const dur   = parseFloat((lines[2] ?? "").trim());
    if (!codec) return null;
    return {
      codec,
      kbps: Number.isFinite(bits) && bits > 0 ? Math.round(bits / 1000) : 0,
      durationSec: Number.isFinite(dur) && dur > 0 ? dur : 0,
    };
  } catch { return null; }
}

/**
 * Egy fájl átkódolása. A forrás MEGMARAD.
 * Visszatérés: az új fájl neve és mérete, vagy null.
 */
async function convert(srcPath) {
  const outPath = path.join(path.dirname(srcPath), withOpusExt(path.basename(srcPath)));

  if (path.resolve(outPath) === path.resolve(srcPath)) {
    const p = await probe(srcPath);
    const trusted = (p?.durationSec ?? 0) >= BITRATE_TRUST_MIN_SEC;
    if (p?.codec === "opus" && (!trusted || p.kbps === 0 || p.kbps <= KEEP_MAX_KBPS)) {
      skipped++;
      return { name: path.basename(outPath), size: fs.statSync(srcPath).size, already: true };
    }
  }

  if (fs.existsSync(outPath) && path.resolve(outPath) !== path.resolve(srcPath)) {
    const p = await probe(outPath);
    if (p?.codec === "opus") {
      skipped++;
      return { name: path.basename(outPath), size: fs.statSync(outPath).size, already: true };
    }
  }

  console.log(`  ↻ ${path.basename(srcPath)} → ${path.basename(outPath)}`);
  if (!APPLY) { converted++; return { name: path.basename(outPath), size: 0, dry: true }; }

  // Ideiglenes néven kódolunk, és csak a SIKERES, nem nulla hosszú eredményt
  // nevezzük át. Egy félbeszakadt ffmpeg így sosem hagy maga után egy
  // lejátszhatatlan "kész" fájlt – az néma csengetés lenne.
  const tmp = outPath + ".converting";
  try {
    await execFileAsync("ffmpeg", [
      "-y", "-i", srcPath, "-vn",
      "-c:a", "libopus", "-b:a", AUDIO_BITRATE, "-application", "audio",
      "-ar", AUDIO_SAMPLE_RATE, "-ac", AUDIO_CHANNELS,
      "-f", "opus", tmp,
    ], { timeout: 180000 });

    const size = fs.statSync(tmp).size;
    if (size === 0) throw new Error("üres kimenet");
    fs.renameSync(tmp, outPath);
    converted++;
    return { name: path.basename(outPath), size };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    console.error(`  ✗ HIBA: ${srcPath}: ${e.message}`);
    failed++;
    return null;
  }
}

async function migrateBellSounds() {
  console.log("\n── Csengetőhangok (BellSoundFile) ──────────────────────────");
  const rows = await prisma.bellSoundFile.findMany();

  for (const row of rows) {
    /*
     * AZ ÜZENET-INTRO HANGOK MÁSHOL VANNAK.
     *
     * A `kind: "MESSAGE_INTRO"` sorok fájljai az `audio/intros/`-ban laknak
     * (ld. bells.routes.ts INTRO_AUDIO_DIR), nem az `audio/bells/`-ben. Ezt
     * a szkript első változata nem tudta, és mind a 11 intro hangot némán
     * kihagyta – "nincs fájl" üzenettel, holott ott voltak.
     */
    const candidates = [
      path.join(BELL_AUDIO_DIR, row.tenantId, row.filename),
      path.join(BELL_AUDIO_DIR, row.filename),
      path.join(INTRO_AUDIO_DIR, row.tenantId, row.filename),
      path.join(INTRO_AUDIO_DIR, row.filename),
    ];
    const src = candidates.find(p => fs.existsSync(p));
    if (!src) {
      console.warn(`  ⚠ nincs fájl: ${row.tenantId}/${row.filename} (DB-sor érintetlen)`);
      continue;
    }

    const res = await convert(src);
    if (!res) continue;
    if (res.name === row.filename && res.already) continue;

    console.log(`     DB: ${row.filename} → ${res.name}`);
    if (APPLY) {
      await prisma.bellSoundFile.update({
        where: { id: row.id },
        data: { filename: res.name, sizeBytes: res.size || row.sizeBytes },
      });
      dbUpdates++;
    }
  }
}

async function migrateBellEntries() {
  console.log("\n── Csengetési rend hivatkozásai (BellEntry.soundFile) ──────");
  const entries = await prisma.bellEntry.findMany();
  const remap = new Map();

  /*
   * CSAK AKKOR ÍRUNK ÁT, HA VAN MIRE.
   *
   * Az első változat minden hivatkozást `.opus`-ra nevezett, függetlenül
   * attól, sikerült-e az átkódolás. Egy hiányzó forrásnál így a hivatkozás
   * egy nem létező `.mp3`-ról egy nem létező `.opus`-ra mutatott – a
   * helyzet nem lett rosszabb, de elfedtük volna, és egy később visszatett
   * eredeti fájlt sem talált volna meg magától.
   */
  const dirs = [BELL_AUDIO_DIR, INTRO_AUDIO_DIR];
  const existsSomewhere = (name) => {
    for (const d of dirs) {
      if (!fs.existsSync(d)) continue;
      if (fs.existsSync(path.join(d, name))) return true;
      for (const sub of fs.readdirSync(d, { withFileTypes: true })) {
        if (sub.isDirectory() && fs.existsSync(path.join(d, sub.name, name))) return true;
      }
    }
    return false;
  };

  for (const e of entries) {
    if (!e.soundFile) continue;
    if (path.extname(e.soundFile).toLowerCase() === AUDIO_EXT) continue;
    const target = withOpusExt(e.soundFile);
    if (!existsSomewhere(target)) {
      console.warn(`  ⚠ kihagyva (nincs átkódolt fájl): ${e.soundFile}`);
      continue;
    }
    remap.set(e.soundFile, target);
  }

  for (const [from, to] of remap) {
    const n = entries.filter(e => e.soundFile === from).length;
    console.log(`  ${from} → ${to}  (${n} bejegyzés)`);
    if (APPLY) {
      const r = await prisma.bellEntry.updateMany({
        where: { soundFile: from },
        data:  { soundFile: to },
      });
      dbUpdates += r.count;
    }
  }
  if (remap.size === 0) console.log("  (nincs átírandó)");
}

async function migrateRadioFiles() {
  console.log("\n── Hangtár (RadioFile) ─────────────────────────────────────");
  const rows = await prisma.radioFile.findMany();

  for (const row of rows) {
    const src = path.join(RADIO_UPLOAD_DIR, row.filename);
    if (!fs.existsSync(src)) {
      console.warn(`  ⚠ nincs fájl: ${row.filename} (DB-sor érintetlen)`);
      continue;
    }

    const res = await convert(src);
    if (!res) continue;
    if (res.name === row.filename && res.already) continue;

    console.log(`     DB: ${row.filename} → ${res.name}`);
    if (APPLY) {
      await prisma.radioFile.update({
        where: { id: row.id },
        data: {
          filename:     res.name,
          originalName: withOpusExt(row.originalName),
          sizeBytes:    res.size || row.sizeBytes,
          fileUrl:      row.fileUrl.replace(/[^/]+$/, res.name),
        },
      });
      dbUpdates++;
    }
  }
}

async function migrateAssets() {
  console.log("\n── Gyári default hangok (assets/bells) ─────────────────────");
  for (const dir of [BELL_ASSET_DIR, BELL_AUDIO_DIR]) {
    if (!fs.existsSync(dir)) { console.log(`  (nincs ilyen könyvtár: ${dir})`); continue; }
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (!fs.statSync(full).isFile()) continue;
      if (!/\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(f)) continue;
      await convert(full);
    }
  }
}

async function migrateMessages() {
  console.log("\n── Üzenet-hangok (Message.fileUrl) ─────────────────────────");
  /*
   * EZ AZ ÁG KÉSŐBB KERÜLT BE, mert a szkript első változata csak a
   * csengetőhangokat és a hangtárat nézte. Az üzenetek hangja az `audio/`
   * GYÖKÉRBEN van (nem alkönyvtárban), és a `Message.fileUrl`-ből hivatkozva –
   * így nyolc régi TTS/felvétel fájl (7 WAV + 1 MP3) maradt volna ki.
   */
  const rows = await prisma.message.findMany({ where: { fileUrl: { not: null } } });
  let touched = 0;

  for (const m of rows) {
    const name = decodeURIComponent(String(m.fileUrl).split("/").pop().split("?")[0]);
    if (!name) continue;
    const src = path.join(MESSAGE_AUDIO_DIR, name);
    if (!fs.existsSync(src)) {
      console.warn(`  ⚠ nincs fájl: ${name} (DB-sor érintetlen)`);
      continue;
    }

    const res = await convert(src);
    if (!res) continue;
    if (res.name === name && res.already) continue;

    console.log(`     DB: ${name} → ${res.name}`);
    if (APPLY) {
      await prisma.message.update({
        where: { id: m.id },
        data:  { fileUrl: m.fileUrl.replace(/[^/]+$/, res.name) },
      });
      dbUpdates++;
    }
    touched++;
  }
  if (touched === 0) console.log("  (nincs átalakítandó)");
}

async function renameDefaultSounds() {
  console.log("\n── Gyári hangok átnevezése angolra ──────────────────────────");
  /*
   * A magyar fájlnevek (jelzocsengo/kibecsengo) angolra váltanak. A nevek a
   * kliensek beépített másolataiban is szerepelnek, ezért a firmware- és
   * kliens-frissítéssel EGYÜTT kell átállniuk.
   *
   * Minden kiterjesztést átnevezünk, az átmeneti MP3 példányt is – azt a
   * failsafe szolgálja ki a régi firmware-eknek, és ha itt lemaradna, azok a
   * régi néven keresnék hiába.
   */
  const MAP = { "jelzocsengo": "assembly-signal-bell", "kibecsengo": "lesson-signal-bell" };
  let files = 0, rows = 0, refs = 0;

  const dirs = [BELL_AUDIO_DIR, BELL_ASSET_DIR];
  if (fs.existsSync(BELL_AUDIO_DIR)) {
    for (const e of fs.readdirSync(BELL_AUDIO_DIR, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(path.join(BELL_AUDIO_DIR, e.name));
    }
  }

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const ext  = path.extname(f);
      const base = path.basename(f, ext);
      const to   = MAP[base];
      if (!to) continue;
      const src = path.join(dir, f), dst = path.join(dir, to + ext);
      if (fs.existsSync(dst)) continue;
      console.log(`  ${path.relative(process.cwd(), src)} → ${to}${ext}`);
      if (APPLY) { try { fs.renameSync(src, dst); files++; } catch (e) { console.error(`  ✗ ${e.message}`); } }
      else files++;
    }
  }

  for (const [from, to] of Object.entries(MAP)) {
    for (const ext of [AUDIO_EXT, ".mp3"]) {
      const oldName = from + ext, newName = to + ext;
      if (APPLY) {
        const r1 = await prisma.bellSoundFile.updateMany({ where: { filename: oldName }, data: { filename: newName } });
        const r2 = await prisma.bellEntry.updateMany({ where: { soundFile: oldName }, data: { soundFile: newName } });
        rows += r1.count; refs += r2.count; dbUpdates += r1.count + r2.count;
      } else {
        rows += await prisma.bellSoundFile.count({ where: { filename: oldName } });
        refs += await prisma.bellEntry.count({ where: { soundFile: oldName } });
      }
    }
  }

  if (files === 0 && rows === 0 && refs === 0) console.log("  (nincs átnevezendő)");
  else console.log(`  fájl: ${files} | BellSoundFile: ${rows} | hivatkozás: ${refs}`);
}

async function main() {
  console.log(APPLY
    ? "═══ ÉLES FUTÁS – a fájlok átkódolódnak, a DB frissül ═══"
    : "═══ SZÁRAZ FUTÁS – semmi nem változik (--apply kell az éleshez) ═══");
  console.log(`Munkakönyvtár: ${process.cwd()}`);

  await renameDefaultSounds();
  await migrateAssets();
  await migrateBellSounds();
  await migrateBellEntries();
  await migrateRadioFiles();
  await migrateMessages();

  console.log("\n═══ ÖSSZEGZÉS ════════════════════════════════════════════");
  console.log(`  átkódolva:      ${converted}`);
  console.log(`  kihagyva:       ${skipped}  (már megfelelő)`);
  console.log(`  hibás:          ${failed}`);
  console.log(`  DB-frissítés:   ${dbUpdates}`);
  if (failed > 0) {
    console.log("\n⚠️  VOLT HIBA. A hozzájuk tartozó DB-sorok ÉRINTETLENEK maradtak,");
    console.log("    tehát a régi fájlra mutatnak – azok továbbra is szólnak.");
  }
  if (!APPLY) console.log("\nSemmi nem változott. Éles futás: --apply");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("VÉGZETES HIBA:", e);
  await prisma.$disconnect();
  process.exit(1);
});
