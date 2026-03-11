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

  // Intézmény neve a tokenbe (AppShell megjelenítéshez)
  let tenantName: string | null = null;
  if (user.tenantId) {
    const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { name: true } });
    tenantName = tenant?.name ?? null;
  }

  // ── Single session ellenőrzés ────────────────────────────────────────────
  // Raw SQL: Prisma schema nem tartalmazza az activeSessionId / lastSeenAt mezőket
  const sessionRow = await prisma.$queryRaw<{ activeSessionId: string | null; lastSeenAt: Date | null; role: string }[]>`
    SELECT "activeSessionId", "lastSeenAt", role FROM "User" WHERE id = ${user.id}
  `;
  const existingSession = sessionRow[0]?.activeSessionId ?? null;
  const lastSeenAt      = sessionRow[0]?.lastSeenAt ?? null;
  const userRole        = sessionRow[0]?.role ?? user.role;

  if (existingSession) {
    // PLAYER szerepkör: sosem tiltjuk ki inaktivitás miatt – a VP folyamatosan fut
    if (userRole === "PLAYER") {
      console.log(`[AUTH] PLAYER re-login allowed (always permitted, no inactivity limit)`);
      // session frissítése folytatódik lentebb
    } else {
      // Inaktivitási küszöb: 60mp
      const inactivityMs = 60_000;
      const lastSeenMs   = lastSeenAt ? Date.now() - new Date(lastSeenAt).getTime() : Infinity;
      const isInactive   = lastSeenMs > inactivityMs;

      if (!isInactive) {
        // Aktív session létezik → nem engedjük be
        return { error: "already_logged_in" } as const;
      }
      console.log(`[AUTH] Session expired for user ${user.id} (inactive ${Math.round(lastSeenMs/1000)}s) → allowing re-login`);
    }
  }

  // Új session ID generálása és mentése
  const sessionId = crypto.randomUUID();
  await prisma.$executeRaw`
    UPDATE "User" SET "activeSessionId" = ${sessionId} WHERE id = ${user.id}
  `;

  const payload: JwtPayload = {
    sub:        user.id,
    role:       user.role,
    tenantId:   user.tenantId ?? null,
    tenantName: tenantName,
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