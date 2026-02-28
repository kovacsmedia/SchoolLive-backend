import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  const email = process.env.EMAIL || "superadmin@schoollive.hu";
  const newPass = process.env.NEW_PASS || "ChangeMe_NOW_123!";
  const rounds = Number(process.env.BCRYPT_ROUNDS || "10");

  const hash = await bcrypt.hash(newPass, rounds);

  const updated = await prisma.user.update({
    where: { email },
    data: { passwordHash: hash },
    select: { email: true, role: true, isActive: true },
  });

  console.log("✅ Password reset OK:", updated);
}

main()
  .catch((e) => {
    console.error("❌ Reset failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });