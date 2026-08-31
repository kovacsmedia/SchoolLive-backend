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

export type LoginClientInfo = {
  clientKey?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
};

export async function login(email: string, password: string, client: LoginClientInfo = {}) {
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

  // ── Multi-session: helyes jelszó = AZONNALI belépés, ÚJ kliensként ───────
  // Nincs várakozás, nincs "already_logged_in" elutasítás – ez egy
  // kommunikációs rendszer felhasználói felülete, mindig rendelkezésre kell
  // állnia. A korábbi egyetlen `User.activeSessionId` mező FELÜLÍRÁSA helyett
  // (ami minden új bejelentkezéskor azonnal kiléptette az ÖSSZES többi
  // klienst – pl. egy másik teremben futó webplayert) most egy ÚJ
  // UserSession sor jön létre: több kliens (pl. a megosztott PLAYER-fiókkal
  // bejelentkezett, teremenkénti webplayerek) egyszerre, egymást nem
  // kiütve maradhat bejelentkezve. Az authJwt middleware a sessionId
  // LÉTEZÉSÉT nézi ebben a táblában, nem egyenlőségét egy globális mezővel.
  const sessionId = crypto.randomUUID();
  const clientType = user.role === "PLAYER" ? "webplayer" : "web";

  const payload: JwtPayload = {
    sub:        user.id,
    role:       user.role,
    tenantId:   user.tenantId ?? null,
    tenantName: tenantName,
    sessionId,
  };

  const token = signAccessToken(payload);

  await prisma.userSession.create({
    data: {
      userId:     user.id,
      sessionId,
      clientType,
      clientKey:  client.clientKey ?? null,
      userAgent:  client.userAgent ?? null,
      ipAddress:  client.ipAddress ?? null,
    },
  });

  return {
    accessToken: token,
    user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenantId ?? null, tenantName: tenantName ?? null, locale: user.locale }
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

// Csak a HÍVÓ SAJÁT munkamenete szűnik meg – a user esetleges többi aktív
// kliense (pl. másik teremben futó webplayer) VÁLTOZATLANUL bejelentkezve
// marad. Ha valamiért nincs sessionId (nagyon régi, a multi-session
// bevezetése előtti token), nincs mit törölni – nem-op, biztonságos.
export async function logout(userId: string, sessionId?: string | null) {
  if (!sessionId) return;
  await prisma.userSession.deleteMany({ where: { userId, sessionId } });
}

export type SessionListItem = {
  id: string;
  sessionId: string;
  clientType: string;
  clientKey: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
};

/** A hívó saját bejelentkezett kliensei (self-service lista). A `sessionId`
 *  a JWT payload mezőjével egyezik – ez alapján jelöli a hívó a SAJÁT
 *  (jelenleg használt) sort "isCurrent"-nek. */
export async function listSessions(userId: string): Promise<SessionListItem[]> {
  return prisma.userSession.findMany({
    where: { userId },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, sessionId: true, clientType: true, clientKey: true, userAgent: true, createdAt: true, lastSeenAt: true },
  });
}

/** Egy konkrét munkamenet (UserSession.id, NEM a JWT sessionId-je)
 *  kényszerített megszüntetése – csak a hívó SAJÁT sorai közül. */
export async function revokeSession(userId: string, sessionRowId: string): Promise<boolean> {
  const r = await prisma.userSession.deleteMany({ where: { id: sessionRowId, userId } });
  return r.count > 0;
}

export async function getMe(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, tenantId: true, isActive: true, locale: true }
  });
}

export async function setLocale(userId: string, locale: string) {
  return prisma.user.update({
    where: { id: userId },
    data:  { locale },
    select: { id: true, locale: true },
  });
}
