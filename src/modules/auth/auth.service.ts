import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "../../prisma/client";
import { env } from "../../config/env";
import { JwtPayload } from "./auth.types";

// Aláír egy access tokent, és a payload-ba kódolt `exp`-ből visszaadja a
// pontos lejárati időpontot is – ezt tároljuk a User.sessionExpiresAt
// mezőben, hogy a single-session ellenőrzés a TÉNYLEGES token-lejárathoz
// tudjon igazodni (nem egy attól független aktivitás-heurisztikához).
function signAccessToken(payload: JwtPayload): { token: string; expiresAt: Date } {
  const token = jwt.sign(
    payload,
    env.JWT_ACCESS_SECRET as jwt.Secret,
    { expiresIn: env.JWT_ACCESS_TTL as any }
  );
  const decoded = jwt.decode(token) as { exp: number };
  return { token, expiresAt: new Date(decoded.exp * 1000) };
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

  // ── Single session ellenőrzés ────────────────────────────────────────────
  // Raw SQL: Prisma schema nem tartalmazza az activeSessionId / lastSeenAt /
  // sessionExpiresAt mezőket
  const sessionRow = await prisma.$queryRaw<{ activeSessionId: string | null; sessionExpiresAt: Date | null; role: string }[]>`
    SELECT "activeSessionId", "sessionExpiresAt", role FROM "User" WHERE id = ${user.id}
  `;
  const existingSession  = sessionRow[0]?.activeSessionId ?? null;
  const sessionExpiresAt = sessionRow[0]?.sessionExpiresAt ?? null;
  const userRole         = sessionRow[0]?.role ?? user.role;

  if (existingSession) {
    // PLAYER szerepkör: sosem tiltjuk ki – a VP folyamatosan fut
    if (userRole === "PLAYER") {
      console.log(`[AUTH] PLAYER re-login allowed (always permitted, no session limit)`);
      // session frissítése folytatódik lentebb
    } else {
      // A régi session TÉNYLEGES token-lejáratához igazodunk (nem egy attól
      // független aktivitás-heurisztikához) – ha a korábban kiadott token
      // már garantáltan lejárt, a régi session halott, azonnal engedünk be.
      // Ha sessionExpiresAt hiányzik (pl. a migráció előtt létrejött session),
      // biztonságosan lejártnak tekintjük – inkább engedjünk be, mint hogy
      // örökre kizárjunk valakit egy hiányzó adat miatt.
      const stillValid = sessionExpiresAt !== null && new Date(sessionExpiresAt).getTime() > Date.now();

      if (stillValid) {
        // Aktív, még nem lejárt session létezik → nem engedjük be
        return { error: "already_logged_in" } as const;
      }
      console.log(`[AUTH] Old session expired for user ${user.id} → allowing re-login`);
    }
  }

  // Új session ID generálása és mentése
  const sessionId = crypto.randomUUID();

  const payload: JwtPayload = {
    sub:        user.id,
    role:       user.role,
    tenantId:   user.tenantId ?? null,
    tenantName: tenantName,
    sessionId,
  };

  const { token, expiresAt } = signAccessToken(payload);

  await prisma.$executeRaw`
    UPDATE "User" SET "activeSessionId" = ${sessionId}, "sessionExpiresAt" = ${expiresAt} WHERE id = ${user.id}
  `;

  return {
    accessToken: token,
    user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenantId ?? null, tenantName: tenantName ?? null }
  };
}

// Aktív (még nem lejárt) token cseréje egy friss TTL-űre, újra bejelentkezés
// (jelszó megadása) nélkül. A frontend ezt hívja periodikusan, amíg az
// admin fül aktív/fókuszban van, hogy egy éppen dolgozó felhasználó
// munkamenete ne járjon le a 15 perces access-token TTL miatt.
export async function refresh(payload: JwtPayload) {
  const { token, expiresAt } = signAccessToken(payload);

  // A session "élettartamát" is meghosszabbítjuk, különben a single-session
  // ellenőrzés a régi (első bejelentkezéskori) lejáratot nézné, és egy
  // aktívan dolgozó user saját magát zárná ki egy másik eszközről való
  // bejelentkezéskor, holott a munkamenete épp csak meghosszabbodott.
  await prisma.$executeRaw`
    UPDATE "User" SET "sessionExpiresAt" = ${expiresAt} WHERE id = ${payload.sub}
  `;

  return { accessToken: token };
}

export async function logout(userId: string) {
  await prisma.$executeRaw`
    UPDATE "User" SET "activeSessionId" = NULL, "sessionExpiresAt" = NULL WHERE id = ${userId}
  `;
}

export async function getMe(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, tenantId: true, isActive: true }
  });
}