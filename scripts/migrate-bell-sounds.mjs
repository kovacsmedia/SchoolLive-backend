// scripts/migrate-bell-sounds.mjs
//
// A csengetőhangok átrendezése a régi, KÖZÖS `audio/bells/<fájlnév>`
// elrendezésből a tenant-szeparált `audio/bells/<tenantId>/<fájlnév>`
// alakba (ld. src/modules/bells/bell-sound-paths.ts).
//
// FUTTATÁS NÉLKÜL IS MŰKÖDIK MINDEN: a backend feloldója előbb a
// tenant-könyvtárban keres, és visszaesik a régi, lapos helyre. Ez a szkript
// csak "rendet rak", hogy a régi fájlok is a helyükre kerüljenek, és egy
// későbbi azonos nevű feltöltés már biztosan ne írhassa felül másik iskola
// hangját.
//
// Használat:
//   node scripts/migrate-bell-sounds.mjs            # SZÁRAZ futás (csak listáz)
//   node scripts/migrate-bell-sounds.mjs --apply    # tényleges másolás
//
// A `.mjs` kiterjesztés SZÁNDÉKOS: a package.json-ben nincs `"type": "module"`,
// tehát a `.js` fájlokat a Node CommonJS-ként értelmezi, és az alábbi `import`
// utasítások `SyntaxError`-t adnának. (Ugyanez a hiba a meglévő
// scripts/backfill-snap-ports.js és scripts/reset-superadmin-password.js
// fájlokban is benne van – azok jelenleg NEM futtathatók így.)
//
// MÁSOL, NEM MOZGAT, és SOSEM TÖRÖL:
//   • Ha két iskola ugyanarra a lapos fájlnévre hivatkozik, mindkettő SAJÁT
//     másolatot kap – ez az egyetlen biztonságos művelet, mert a lapos fájl
//     addig kell, amíg minden hivatkozó tenant meg nem kapta a magáét.
//   • A lapos fájlok a helyükön maradnak; ha a szkript hibátlanul lefutott és
//     a rendszer stabilan megy, kézzel törölheted őket (a szkript kiírja,
//     melyek váltak feleslegessé).
//
// ⚠ FIGYELEM – amit ez a szkript NEM tud helyrehozni:
// Ha a régi elrendezésben két iskola azonos nevű hangot töltött fel, a
// második feltöltés MÁR FELÜLÍRTA az elsőét, és az eredeti hang elveszett.
// A másolás után MINDKÉT iskola a túlélő (utoljára feltöltött) hangot kapja.
// A szkript kilistázza az ilyen ütköző neveket – ezeknél az érintett
// iskoláknak újra fel kell tölteniük a saját hangjukat.

import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const prisma = new PrismaClient();

const APPLY = process.argv.includes("--apply");
const BELL_AUDIO_DIR = path.join(process.cwd(), "audio", "bells");

async function main() {
  console.log(`[MIGRATE-BELL-SOUNDS] Könyvtár: ${BELL_AUDIO_DIR}`);
  console.log(`[MIGRATE-BELL-SOUNDS] Mód: ${APPLY ? "ALKALMAZÁS (--apply)" : "SZÁRAZ FUTÁS (nem ír semmit)"}`);

  if (!fs.existsSync(BELL_AUDIO_DIR)) {
    console.error(`[MIGRATE-BELL-SOUNDS] HIBA: a könyvtár nem létezik. A repó gyökeréből futtasd (/opt/schoollive/backend).`);
    process.exit(1);
  }

  const sounds = await prisma.bellSoundFile.findMany({
    where:  { kind: "SCHEDULE" },
    select: { tenantId: true, filename: true },
    orderBy: [{ tenantId: "asc" }, { filename: "asc" }],
  });

  console.log(`[MIGRATE-BELL-SOUNDS] ${sounds.length} SCHEDULE hangfájl-rekord az adatbázisban.`);

  // Ütköző nevek felderítése: ugyanaz a fájlnév több tenantnál.
  const tenantsByName = new Map();
  for (const s of sounds) {
    if (!tenantsByName.has(s.filename)) tenantsByName.set(s.filename, []);
    tenantsByName.get(s.filename).push(s.tenantId);
  }

  let copied = 0, already = 0, missing = 0;
  const flatStillUsed = new Set();

  for (const s of sounds) {
    const scoped = path.join(BELL_AUDIO_DIR, s.tenantId, s.filename);
    const legacy = path.join(BELL_AUDIO_DIR, s.filename);

    if (fs.existsSync(scoped)) {
      already++;
      continue;
    }
    if (!fs.existsSync(legacy)) {
      console.warn(`  ⚠ HIÁNYZIK a lemezen: ${s.filename} (tenant=${s.tenantId}) – az iskolának újra fel kell töltenie`);
      missing++;
      continue;
    }

    console.log(`  → ${s.filename}  ⇒  ${s.tenantId}/${s.filename}`);
    flatStillUsed.add(s.filename);

    if (APPLY) {
      fs.mkdirSync(path.join(BELL_AUDIO_DIR, s.tenantId), { recursive: true });
      fs.copyFileSync(legacy, scoped);
    }
    copied++;
  }

  console.log("");
  console.log(`[MIGRATE-BELL-SOUNDS] Összegzés:`);
  console.log(`  másolva / másolandó : ${copied}`);
  console.log(`  már a helyén        : ${already}`);
  console.log(`  hiányzik a lemezen  : ${missing}`);

  const collisions = [...tenantsByName.entries()].filter(([, t]) => t.length > 1);
  if (collisions.length > 0) {
    console.log("");
    console.log(`⚠ ÜTKÖZŐ FÁJLNEVEK (${collisions.length} db) – ezeknél a régi elrendezésben`);
    console.log(`  a későbbi feltöltés felülírta a korábbit, tehát MOST minden érintett`);
    console.log(`  iskola UGYANAZT a hangot kapja. Ellenőrizd, és ahol nem stimmel,`);
    console.log(`  töltsd fel újra az adott iskola saját hangját:`);
    for (const [name, tenants] of collisions) {
      console.log(`    • ${name} → ${tenants.length} iskola: ${tenants.join(", ")}`);
    }
  }

  if (!APPLY && copied > 0) {
    console.log("");
    console.log(`Tényleges végrehajtás:  node scripts/migrate-bell-sounds.mjs --apply`);
  }
  if (APPLY && flatStillUsed.size > 0) {
    console.log("");
    console.log(`A másolás kész. A régi, lapos fájlok SZÁNDÉKOSAN megmaradtak (biztonsági háló).`);
    console.log(`Ha minden rendben megy, ezek később kézzel törölhetők:`);
    for (const f of [...flatStillUsed].sort()) console.log(`    audio/bells/${f}`);
  }
}

main()
  .catch((e) => { console.error("[MIGRATE-BELL-SOUNDS] HIBA:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
