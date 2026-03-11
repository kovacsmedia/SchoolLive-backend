import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "../../prisma/client";
import { env } from "../../config/env";
import { JwtPayload } from "./auth.types";

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.isActive) return null;

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;

  // ── Single session ellenőrzés ────────────────────────────────────────────
  // Raw SQL: Prisma schema nem tartalmazza az activeSessionId mezőt
  const sessionRow = await prisma.$queryRaw<{ activeSessionId: string | null }[]>`
    SELECT "activeSessionId" FROM "User" WHERE id = ${user.id}
  `;
  const existingSession = sessionRow[0]?.activeSessionId ?? null;

  if (existingSession) {
    return { error: "already_logged_in" } as const;
  }

  // Új session ID generálása és mentése
  const sessionId = crypto.randomUUID();
  await prisma.$executeRaw`
    UPDATE "User" SET "activeSessionId" = ${sessionId} WHERE id = ${user.id}
  `;

  const payload: JwtPayload = {
    sub:      user.id,
    role:     user.role,
    tenantId: user.tenantId ?? null,
    sessionId,
  };

  const token = jwt.sign(
    payload,
    env.JWT_ACCESS_SECRET as jwt.Secret,
    { expiresIn: env.JWT_ACCESS_TTL as any }
  );

  return {
    accessToken: token,
    user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenantId ?? null }
  };
}

export async function logout(userId: string) {
  await prisma.$executeRaw`
    UPDATE "User" SET "activeSessionId" = NULL WHERE id = ${userId}
  `;
}

export async function getMe(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, tenantId: true, isActive: true }
  });
}