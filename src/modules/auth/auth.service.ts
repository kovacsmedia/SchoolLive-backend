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

  // ── Session-szemantika: PLAYER = multi-session, mindenki más = single ───
  //
  // PLAYER (megosztott webplayer-fiók, teremenként egy böngésző-példány):
  //   minden bejelentkezés ÚJ, egymást nem kiütő UserSession sort kap – a
  //   Terem A webplayerének belépése NEM léptetheti ki a Terem B webplayerét.
  //   Az ilyen session-t KIZÁRÓLAG a device.lifecycle.ts zárja le, ha a hozzá
  //   tartozó Device 10 percnél régebben nem beaconolt (ld. ott).
  //
  // Mindenki más (ember-admin fiók): a régi, "single session" szemantika –
  // egy ÚJ, helyes jelszavas bejelentkezés a felhasználó ÖSSZES korábbi
  // munkamenetét lezárja. Ez SZÁNDÉKOS (nem hiba, amit korábban a webplayer
  // miatt kijavítottunk): embernél a "bejelentkeztem egy másik gépről"
  // tényleg azt jelenti, hogy az előző helyet nem használja tovább.
  //
  // Egyik ágnál SINCS idő-alapú lejárat (ld. env.ts JWT_ACCESS_TTL) – a
  // munkamenet csak explicit logout / (ember esetén) új login / (PLAYER
  // esetén) a device 10 perces offline-timeoutja miatt szűnik meg, SOSEM
  // "csendben", gépelés/hosszabb inaktivitás közben.
  const sessionId = crypto.randomUUID();
  const isPlayer = user.role === "PLAYER";
  const clientType = isPlayer ? "webplayer" : "web";

  const payload: JwtPayload = {
    sub:        user.id,
    role:       user.role,
    tenantId:   user.tenantId ?? null,
    tenantName: tenantName,
    sessionId,
  };

  const token = signAccessToken(payload);

  if (!isPlayer) {
    await prisma.userSession.deleteMany({ where: { userId: user.id } });
  }

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

// Aktív token cseréje egy friss TTL-űre, jelszó megadása nélkül. Mivel a
// JWT_ACCESS_TTL mostantól gyakorlatilag lejárat nélküli (ld. env.ts), ez
// már nem kritikus-útvonal – csak defenzív frissítés. A sessionId
// változatlan marad a payloadban, úgyhogy nem kell semmit frissíteni az
// adatbázisban.
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
