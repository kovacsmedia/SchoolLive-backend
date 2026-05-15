// scripts/backfill-snap-ports.js
//
// Retroaktív snapPort kiosztás a meglévő tenant-eknek, amelyeknek még NULL
// a `snapPort` mezője. Az új tenant-create flow (POST /admin/tenants) már
// automatikusan kiosztja, de a feature bevezetése előtt létrejött tenant-ek
// nem kaptak port-ot – ezt egyszer le kell futtatni a deploy-on.
//
// Használat:
//   node scripts/backfill-snap-ports.js
//
// Opcionális env-változók (alapérték: 1800–1880):
//   SNAP_PORT_BASE=1800
//   SNAP_PORT_MAX=1880
//
// Idempotens: ismételt futtatáskor nem változtat semmit, csak kilistázza
// a már lefoglalt port-okat. Ha a tartomány teli, a felesleges tenant-eket
// kiírja, hogy melyik nem kapott port-ot (manuálisan kell ezzel foglalkozni:
// vagy szélesíteni a tartományt, vagy törölni nem-használt tenant-et).

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SNAP_PORT_BASE = Number(process.env.SNAP_PORT_BASE ?? "1800");
const SNAP_PORT_MAX  = Number(process.env.SNAP_PORT_MAX  ?? "1880");

async function main() {
  console.log(`Backfill snapPort: range=${SNAP_PORT_BASE}..${SNAP_PORT_MAX}`);

  // 1. Már kiosztott portok lekérdezése.
  const taken = new Set();
  const allWithPort = await prisma.tenant.findMany({
    where:  { snapPort: { not: null } },
    select: { id: true, name: true, snapPort: true },
    orderBy: { snapPort: "asc" },
  });
  for (const t of allWithPort) taken.add(t.snapPort);

  console.log(`  - Foglalt portok (${allWithPort.length}):`);
  for (const t of allWithPort) {
    console.log(`      ${t.snapPort}  ${t.name}  (${t.id})`);
  }

  // 2. NULL snapPort-ú tenant-ek.
  const missing = await prisma.tenant.findMany({
    where:  { snapPort: null },
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  if (missing.length === 0) {
    console.log("✅ Nincs backfill-elendő tenant – minden snapPort ki van osztva.");
    return;
  }

  console.log(`  - NULL snapPort-ú tenant-ek (${missing.length}):`);
  for (const t of missing) {
    console.log(`      ${t.name}  (${t.id})`);
  }

  // 3. Port-allokáció: a tartomány legkisebb szabad slot-ját választjuk.
  function nextFreePort() {
    for (let p = SNAP_PORT_BASE; p <= SNAP_PORT_MAX; p++) {
      if (!taken.has(p)) {
        taken.add(p);
        return p;
      }
    }
    return null;
  }

  let assigned = 0;
  const overflow = [];
  for (const t of missing) {
    const port = nextFreePort();
    if (port === null) {
      overflow.push(t);
      continue;
    }
    await prisma.tenant.update({
      where: { id: t.id },
      data:  { snapPort: port },
    });
    console.log(`  ✓ ${t.name}  →  snapPort=${port}`);
    assigned++;
  }

  console.log(`\n✅ Kiosztva: ${assigned} tenant.`);

  if (overflow.length > 0) {
    console.error(`\n⚠️  ${overflow.length} tenant nem kapott port-ot (tartomány teli):`);
    for (const t of overflow) {
      console.error(`   - ${t.name}  (${t.id})`);
    }
    console.error(`   Bővítsd a SNAP_PORT_MAX env-et, vagy töröld a nem-használt tenant-eket.`);
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error("❌ Backfill hiba:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
