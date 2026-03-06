const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");
const prisma = new PrismaClient();

const NORMAL_BELLS = [
  { hour: 7,  minute: 30, type: "SIGNAL", soundFile: "jelzocsengo.mp3" },
  { hour: 7,  minute: 55, type: "SIGNAL", soundFile: "jelzocsengo.mp3" },
  { hour: 8,  minute: 0,  type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 8,  minute: 45, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 8,  minute: 53, type: "SIGNAL", soundFile: "jelzocsengo.mp3" },
  { hour: 8,  minute: 55, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 9,  minute: 40, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 9,  minute: 53, type: "SIGNAL", soundFile: "jelzocsengo.mp3" },
  { hour: 9,  minute: 55, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 10, minute: 40, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 10, minute: 48, type: "SIGNAL", soundFile: "jelzocsengo.mp3" },
  { hour: 10, minute: 50, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 11, minute: 35, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 11, minute: 53, type: "SIGNAL", soundFile: "jelzocsengo.mp3" },
  { hour: 11, minute: 55, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 12, minute: 40, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 12, minute: 48, type: "SIGNAL", soundFile: "jelzocsengo.mp3" },
  { hour: 12, minute: 50, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 13, minute: 35, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 14, minute: 10, type: "SIGNAL", soundFile: "jelzocsengo.mp3" },
  { hour: 14, minute: 15, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 15, minute: 0,  type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 15, minute: 13, type: "SIGNAL", soundFile: "jelzocsengo.mp3" },
  { hour: 15, minute: 15, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 16, minute: 0,  type: "MAIN",   soundFile: "kibecsengo.mp3" },
];

const SHORT_BELLS = [
  { hour: 7,  minute: 30, type: "SIGNAL", soundFile: "jelzocsengo.mp3" },
  { hour: 7,  minute: 55, type: "SIGNAL", soundFile: "jelzocsengo.mp3" },
  { hour: 8,  minute: 0,  type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 8,  minute: 30, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 8,  minute: 33, type: "SIGNAL", soundFile: "jelzocsengo.mp3" },
  { hour: 8,  minute: 35, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 9,  minute: 5,  type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 9,  minute: 13, type: "SIGNAL", soundFile: "jelzocsengo.mp3" },
  { hour: 9,  minute: 15, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 9,  minute: 45, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 9,  minute: 48, type: "SIGNAL", soundFile: "jelzocsengo.mp3" },
  { hour: 9,  minute: 50, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 10, minute: 20, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 10, minute: 23, type: "SIGNAL", soundFile: "jelzocsengo.mp3" },
  { hour: 10, minute: 25, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 10, minute: 55, type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 10, minute: 58, type: "SIGNAL", soundFile: "jelzocsengo.mp3" },
  { hour: 11, minute: 0,  type: "MAIN",   soundFile: "kibecsengo.mp3" },
  { hour: 11, minute: 30, type: "MAIN",   soundFile: "kibecsengo.mp3" },
];

async function main() {
  const tenantName = process.env.SEED_TENANT_NAME || "Demo Iskola";
  const superEmail = process.env.SEED_SUPER_EMAIL || "superadmin@schoollive.hu";
  const superPass  = process.env.SEED_SUPER_PASSWORD || "ChangeMe_NOW_123!";

  // 1) Tenant
  const tenant = await prisma.tenant.upsert({
    where: { domain: "schoollive.hu" },
    update: {},
    create: { name: tenantName, domain: "schoollive.hu", isActive: true },
  });

  // 2) SUPER_ADMIN
  const passwordHash = await bcrypt.hash(superPass, 12);
  await prisma.user.upsert({
    where: { email: superEmail },
    update: {},
    create: { email: superEmail, passwordHash, role: "SUPER_ADMIN", isActive: true, tenantId: null },
  });

  // 3) Alap csengetési sablonok (ha még nem léteznek)
  const normalExists = await prisma.bellScheduleTemplate.findFirst({
    where: { tenantId: tenant.id, name: "Normál csengetési rend" },
  });
  if (!normalExists) {
    await prisma.bellScheduleTemplate.create({
      data: {
        tenantId: tenant.id,
        name: "Normál csengetési rend",
        isDefault: true,
        isLocked: true,
        bells: { create: NORMAL_BELLS },
      },
    });
    console.log("✅ Normál csengetési rend sablon létrehozva");
  }

  const shortExists = await prisma.bellScheduleTemplate.findFirst({
    where: { tenantId: tenant.id, name: "Rövidített csengetési rend" },
  });
  if (!shortExists) {
    await prisma.bellScheduleTemplate.create({
      data: {
        tenantId: tenant.id,
        name: "Rövidített csengetési rend",
        isDefault: false,
        isLocked: true,
        bells: { create: SHORT_BELLS },
      },
    });
    console.log("✅ Rövidített csengetési rend sablon létrehozva");
  }

  // 4) Alap hangfájlok regisztrálása
  const defaultSounds = [
    { filename: "jelzocsengo.mp3", sizeBytes: 132492 },
    { filename: "kibecsengo.mp3",  sizeBytes: 104108 },
  ];
  for (const s of defaultSounds) {
    await prisma.bellSoundFile.upsert({
      where: { tenantId_filename: { tenantId: tenant.id, filename: s.filename } },
      update: {},
      create: { tenantId: tenant.id, filename: s.filename, sizeBytes: s.sizeBytes, isDefault: true },
    });
  }
  console.log("✅ Alap hangfájlok regisztrálva");

  console.log("✅ Seed completed");
  console.log("Tenant:", tenant.id, tenant.name);
  console.log("Superadmin:", superEmail);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });