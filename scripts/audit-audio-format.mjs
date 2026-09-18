// scripts/audit-audio-format.mjs
//
// ELLENŐRZI, hogy MINDEN adatbázis-hivatkozáshoz létezik-e a hang a rendszer
// egységes formátumában (Opus 96k, ld. src/utils/audio-format.ts), és
// `--apply`-jal elő is állítja, ami hiányzik.
//
//   node scripts/audit-audio-format.mjs            # csak jelent
//   node scripts/audit-audio-format.mjs --apply    # elő is állítja
//
// MIÉRT KÜLÖN A MIGRÁCIÓTÓL: a `migrate-audio-to-opus.mjs` a LEMEZT járja be
// könyvtáranként (tömeges átalakítás), ez viszont a HIVATKOZÁSOK felől indul.
// A kettő más hibát talál meg. Élesben ez derítette ki, hogy a migráció első
// változata kihagyta az üzenet-hangokat: azok az `audio/` GYÖKÉRBEN vannak,
// nem alkönyvtárban, és a `Message.fileUrl`-ből hivatkozva – nyolc régi WAV/MP3
// maradt volna a rendszerben.
//
// A régi fájlokat NEM törli (a failsafe azokból él, ld. LEGACY_MP3_FALLBACK).
// Idempotens: ami már rendben van, azt nem bántja.
//
// Deploy után is érdemes lefuttatni – egyetlen hiányzó formátum néma
// csengetést vagy néma üzenetet jelent.

import { PrismaClient } from "@prisma/client";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const ex = promisify(execFile);
const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const AUDIO      = path.join(process.cwd(), "audio");
const BELLS      = path.join(AUDIO, "bells");
const INTROS     = path.join(AUDIO, "intros");
const RADIO      = path.join(process.cwd(), "uploads", "radio");
const ASSETS     = path.join(process.cwd(), "assets", "bells");

async function codecOf(p) {
  try {
    const { stdout } = await ex("ffprobe", ["-v","quiet","-select_streams","a:0",
      "-show_entries","stream=codec_name","-of","default=noprint_wrappers=1:nokey=1", p], { timeout: 15000 });
    return stdout.trim().toLowerCase() || null;
  } catch { return null; }
}

/** Megkeresi a fájlt a megadott könyvtárakban (alkönyvtárakkal együtt). */
function locate(name, dirs) {
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const direct = path.join(d, name);
    if (fs.existsSync(direct)) return direct;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const toOpusName = n => n.replace(/\.[^.]+$/, "") + ".opus";

async function convert(src) {
  const out = path.join(path.dirname(src), toOpusName(path.basename(src)));
  if (fs.existsSync(out) && (await codecOf(out)) === "opus") return { out, already: true };
  if (!APPLY) return { out, dry: true };
  const tmp = out + ".converting";
  try {
    await ex("ffmpeg", ["-y","-i",src,"-vn","-c:a","libopus","-b:a","128k",
                        "-application","audio","-ar","48000","-ac","2","-f","opus",tmp], { timeout: 180000 });
    if (fs.statSync(tmp).size === 0) throw new Error("üres kimenet");
    fs.renameSync(tmp, out);
    return { out };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return { error: e.message };
  }
}

let missing = 0, wrongFmt = 0, fixed = 0, failed = 0, ok = 0;

async function checkRef(label, name, dirs, onFixed) {
  if (!name) return;
  // Már opus nevű és tényleg opus? rendben.
  const opusName = toOpusName(name);
  const opusPath = locate(opusName, dirs);
  if (opusPath && (await codecOf(opusPath)) === "opus") { ok++; return; }

  // Van-e BÁRMILYEN forrás, amiből elő tudjuk állítani?
  const src = locate(name, dirs) ?? opusPath;
  if (!src) { missing++; console.log(`  ✗ NINCS FÁJL   ${label}: ${name}`); return; }

  const c = await codecOf(src);
  wrongFmt++;
  console.log(`  ⚠ ROSSZ FORMÁTUM ${label}: ${path.relative(process.cwd(), src)} (${c ?? "olvashatatlan"})`);
  const r = await convert(src);
  if (r.error) { failed++; console.log(`     ✗ konverzió hiba: ${r.error}`); return; }
  if (r.dry)   { console.log(`     → lenne: ${path.basename(r.out)}`); return; }
  fixed++;
  console.log(`     ✓ ${path.basename(r.out)}`);
  if (onFixed) await onFixed(path.basename(r.out), fs.statSync(r.out).size);
}

console.log(APPLY ? "═══ ÉLES ═══" : "═══ SZÁRAZ (--apply az éleshez) ═══");

console.log("\n── BellSoundFile ──");
for (const r of await prisma.bellSoundFile.findMany())
  await checkRef("bell", r.filename, [path.join(BELLS, r.tenantId), BELLS, path.join(INTROS, r.tenantId), INTROS],
    async (n, sz) => { await prisma.bellSoundFile.update({ where: { id: r.id }, data: { filename: n, sizeBytes: sz } }); });

console.log("\n── BellEntry.soundFile ──");
for (const f of [...new Set((await prisma.bellEntry.findMany({ select: { soundFile: true } })).map(b => b.soundFile))])
  await checkRef("entry", f, [BELLS, INTROS]);

console.log("\n── RadioFile ──");
for (const r of await prisma.radioFile.findMany())
  await checkRef("radio", r.filename, [RADIO],
    async (n, sz) => { await prisma.radioFile.update({ where: { id: r.id },
      data: { filename: n, sizeBytes: sz, originalName: toOpusName(r.originalName), fileUrl: r.fileUrl.replace(/[^/]+$/, n) } }); });

console.log("\n── Message.fileUrl ──");
for (const m of await prisma.message.findMany({ where: { fileUrl: { not: null } } })) {
  const name = decodeURIComponent(String(m.fileUrl).split("/").pop().split("?")[0]);
  await checkRef("msg", name, [AUDIO],
    async (n) => { await prisma.message.update({ where: { id: m.id }, data: { fileUrl: m.fileUrl.replace(/[^/]+$/, n) } }); });
}

console.log("\n── assets/bells (gyári defaultok) ──");
if (fs.existsSync(ASSETS)) for (const f of fs.readdirSync(ASSETS))
  if (/\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(f)) await checkRef("asset", f, [ASSETS]);

// ── Hiányzó hossz-adat pótlása ──────────────────────────────────────────────
// A felület a lista sorában kiírja a hang hosszát; a régi sorokban ez null,
// mert korábban csak az intro hangoknál mértük.
// ── Elavult méret-adat ──────────────────────────────────────────────────────
// Az eszköz a lista `sizeBytes` mezőjét hasonlítja a letöltött fájlhoz.
// Ha a kettő szétcsúszik, minden szinkronnál újratölt – és a régi firmware
// a hibátlan fájlt is eldobta. (Élesben a gyári hangoknál pont ez történt:
// a migráció "már Opus" alapon átugrotta őket, a méret viszont a korábbi
// átkódolásé maradt.)
console.log("\n=== Elavult méret-adat (sizeBytes) ===");
let sz = 0;
for (const r of await prisma.bellSoundFile.findMany()) {
  const p = locate(r.filename, [path.join(BELLS, r.tenantId), BELLS, path.join(INTROS, r.tenantId), INTROS]);
  if (!p) continue;
  let real = 0;
  try { real = fs.statSync(p).size; } catch { continue; }
  if (!real || real === r.sizeBytes) continue;
  console.log(`  ${r.filename}: DB ${r.sizeBytes} → lemez ${real}`);
  if (APPLY) await prisma.bellSoundFile.update({ where: { id: r.id }, data: { sizeBytes: real } });
  sz++;
}
if (sz === 0) console.log("  (mind egyezik)");

console.log("\n=== Hiányzó hossz-adat (durationMs) ===");
let dur = 0;
for (const r of await prisma.bellSoundFile.findMany({ where: { durationMs: null } })) {
  const p = locate(r.filename, [path.join(BELLS, r.tenantId), BELLS, path.join(INTROS, r.tenantId), INTROS]);
  if (!p) continue;
  try {
    const { stdout } = await ex("ffprobe", ["-v","quiet","-show_entries","format=duration",
      "-of","default=noprint_wrappers=1:nokey=1", p], { timeout: 15000 });
    const sec = parseFloat(String(stdout).trim());
    if (!Number.isFinite(sec) || sec <= 0) continue;
    const ms = Math.round(sec * 1000);
    console.log(`  ${r.filename} → ${(ms/1000).toFixed(1)}s`);
    if (APPLY) await prisma.bellSoundFile.update({ where: { id: r.id }, data: { durationMs: ms } });
    dur++;
  } catch { /* nem kritikus */ }
}
if (dur === 0) console.log("  (mindenhol megvan)");

console.log(`\n═══ ÖSSZEGZÉS ═══`);
console.log(`  rendben:          ${ok}`);
console.log(`  rossz formátum:   ${wrongFmt}  → javítva: ${fixed}, hibás: ${failed}`);
console.log(`  hiányzó fájl:     ${missing}`);
console.log(`  hossz pótolva:    ${dur}`);
console.log(`  méret javítva:    ${sz}`);
if (!APPLY && wrongFmt > 0) console.log(`\n  Semmi nem változott. Éles: --apply`);
await prisma.$disconnect();
