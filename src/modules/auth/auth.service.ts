import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "../../prisma/client";
import { env } from "../../config/env";
import { JwtPayload } from "./auth.types";

function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(
    payload,
    env.JWT_ACCESS_SECRET as jwt.Secret,
    { expiresIn: env.JWT_ACCESS_TTL as any }
  );
}

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

  // ── Single session: helyes jelszó = AZONNALI belépés ─────────────────────
  // Nincs várakozás, nincs "already_logged_in" elutasítás – ez egy
  // kommunikációs rendszer felhasználói felülete, mindig rendelkezésre kell
  // állnia. Az új sessionId felülírja a régit; a authJwt middleware minden
  // kérésnél összeveti a token sessionId-jét a User.activeSessionId-vel, így
  // a régi (bárhol máshol futó) session a KÖVETKEZŐ kérésénél azonnal
  // 401 session_superseded-et kap – nincs szükség előzetes ellenőrzésre itt.
  const sessionId = crypto.randomUUID();

  const payload: JwtPayload = {
    sub:        user.id,
    role:       user.role,
    tenantId:   user.tenantId ?? null,
    tenantName: tenantName,
    sessionId,
  };

  const token = signAccessToken(payload);

  await prisma.$executeRaw`
    UPDATE "User" SET "activeSessionId" = ${sessionId} WHERE id = ${user.id}
  `;

  return {
    accessToken: token,
    user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenantId ?? null, tenantName: tenantName ?? null }
  };
}

// Aktív (még nem lejárt, és még nem felülírt) token cseréje egy friss
// TTL-űre, újra bejelentkezés (jelszó megadása) nélkül. A frontend ezt
// hívja periodikusan, amíg az admin fül aktív/fókuszban van, hogy egy
// éppen dolgozó felhasználó munkamenete ne járjon le a 15 perces
// access-token TTL miatt. A sessionId változatlan marad a payloadban,
// úgyhogy nem kell semmit frissíteni az adatbázisban.
export async function refresh(payload: JwtPayload) {
  const token = signAccessToken(payload);
  return { accessToken: token };
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
