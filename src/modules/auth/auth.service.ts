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

  const payload: JwtPayload = {
    sub: user.id,
    role: user.role,
    tenantId: user.tenantId ?? null
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

export async function getMe(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, tenantId: true, isActive: true }
  });
}
