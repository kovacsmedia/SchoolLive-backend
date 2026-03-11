import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../../prisma/client";
import { env } from "../../config/env";
import { JwtPayload } from "./auth.types";

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.isActive) return null;

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;

  // ── Single session ellenőrzés ────────────────────────────────────────────
  // Ha már van aktív session ID, visszautasítjuk a bejelentkezést
  if ((user as any).activeSessionId) {
    return { error: "already_logged_in" } as const;
  }

  // Új session ID generálása
  const sessionId = uuidv4();

  // Session ID mentése a userhez
  await prisma.user.update({
    where: { id: user.id },
    data: { activeSessionId: sessionId } as any,
  });

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
  await prisma.user.update({
    where: { id: userId },
    data: { activeSessionId: null } as any,
  });
}

export async function getMe(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, tenantId: true, isActive: true }
  });
}