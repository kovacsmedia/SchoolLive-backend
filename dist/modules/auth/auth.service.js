"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.login = login;
exports.logout = logout;
exports.getMe = getMe;
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const client_1 = require("../../prisma/client");
const env_1 = require("../../config/env");
async function login(email, password) {
    const user = await client_1.prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive)
        return null;
    const ok = await bcrypt_1.default.compare(password, user.passwordHash);
    if (!ok)
        return null;
    // Intézmény neve a tokenbe (AppShell megjelenítéshez)
    let tenantName = null;
    if (user.tenantId) {
        const tenant = await client_1.prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { name: true } });
        tenantName = tenant?.name ?? null;
    }
    // ── Single session ellenőrzés ────────────────────────────────────────────
    // Raw SQL: Prisma schema nem tartalmazza az activeSessionId / lastSeenAt mezőket
    const sessionRow = await client_1.prisma.$queryRaw `
    SELECT "activeSessionId", "lastSeenAt", role FROM "User" WHERE id = ${user.id}
  `;
    const existingSession = sessionRow[0]?.activeSessionId ?? null;
    const lastSeenAt = sessionRow[0]?.lastSeenAt ?? null;
    const userRole = sessionRow[0]?.role ?? user.role;
    if (existingSession) {
        // PLAYER szerepkör: sosem tiltjuk ki inaktivitás miatt – a VP folyamatosan fut
        if (userRole === "PLAYER") {
            console.log(`[AUTH] PLAYER re-login allowed (always permitted, no inactivity limit)`);
            // session frissítése folytatódik lentebb
        }
        else {
            // Inaktivitási küszöb: 60mp
            const inactivityMs = 60_000;
            const lastSeenMs = lastSeenAt ? Date.now() - new Date(lastSeenAt).getTime() : Infinity;
            const isInactive = lastSeenMs > inactivityMs;
            if (!isInactive) {
                // Aktív session létezik → nem engedjük be
                return { error: "already_logged_in" };
            }
            console.log(`[AUTH] Session expired for user ${user.id} (inactive ${Math.round(lastSeenMs / 1000)}s) → allowing re-login`);
        }
    }
    // Új session ID generálása és mentése
    const sessionId = crypto.randomUUID();
    await client_1.prisma.$executeRaw `
    UPDATE "User" SET "activeSessionId" = ${sessionId} WHERE id = ${user.id}
  `;
    const payload = {
        sub: user.id,
        role: user.role,
        tenantId: user.tenantId ?? null,
        tenantName: tenantName,
        sessionId,
    };
    const token = jsonwebtoken_1.default.sign(payload, env_1.env.JWT_ACCESS_SECRET, { expiresIn: env_1.env.JWT_ACCESS_TTL });
    return {
        accessToken: token,
        user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenantId ?? null, tenantName: tenantName ?? null }
    };
}
async function logout(userId) {
    await client_1.prisma.$executeRaw `
    UPDATE "User" SET "activeSessionId" = NULL WHERE id = ${userId}
  `;
}
async function getMe(userId) {
    return client_1.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, role: true, tenantId: true, isActive: true }
    });
}
