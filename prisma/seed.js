const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");

const prisma = new PrismaClient();

async function main() {
  const tenantName = process.env.SEED_TENANT_NAME || "Demo Iskola";
  const superEmail = process.env.SEED_SUPER_EMAIL || "superadmin@schoollive.hu";
  const superPass  = process.env.SEED_SUPER_PASSWORD || "ChangeMe_NOW_123!";

  // 1) Tenant létrehozás / upsert
  const tenant = await prisma.tenant.upsert({
    where: { domain: "schoollive.hu" },
    update: {},
    create: {
      name: tenantName,
      domain: "schoollive.hu",
      isActive: true,
    },
  });

  // 2) SUPER_ADMIN létrehozás (tenantId lehet null, de mi most tenanthez köthetjük is)
  const passwordHash = await bcrypt.hash(superPass, 12);

  await prisma.user.upsert({
    where: { email: superEmail },
    update: {},
    create: {
      email: superEmail,
      passwordHash,
      role: "SUPER_ADMIN",
      isActive: true,
      tenantId: null, // SUPER_ADMIN globális
    },
  });

  console.log("✅ Seed completed");
  console.log("Tenant:", tenant.id, tenant.name);
  console.log("Superadmin:", superEmail);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
