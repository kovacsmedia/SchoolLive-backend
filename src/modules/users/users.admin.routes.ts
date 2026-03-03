import { Router } from "express";
import { prisma } from "../../prisma/client";
import { authJwt } from "../../middleware/authJwt";
import { requireTenant } from "../../middleware/tenant";

// ⚠️ Ha nálatok bcryptjs van, cseréld erre:
// import bcrypt from "bcryptjs";
import bcrypt from "bcrypt";

const router = Router();

type JwtUser = {
  sub?: string;
  role?: string;
  tenantId?: string | null;
};

const ALLOWED_TENANT_ROLES = ["TENANT_ADMIN", "ORG_ADMIN", "TEACHER", "OPERATOR", "PLAYER"] as const;
type TenantRole = (typeof ALLOWED_TENANT_ROLES)[number];

function isTenantRole(x: unknown): x is TenantRole {
  return typeof x === "string" && (ALLOWED_TENANT_ROLES as readonly string[]).includes(x);
}

function requireAdminWriteAccess(user: JwtUser) {
  // Írási műveletek:
  // - SUPER_ADMIN: tenant contexttel (x-tenant-id + requireTenant)
  // - TENANT_ADMIN: tenant admin
  return user?.role === "SUPER_ADMIN" || user?.role === "TENANT_ADMIN";
}

function requireAdminReadAccess(user: JwtUser) {
  // Olvasáshoz:
  return user?.role === "SUPER_ADMIN" || user?.role === "TENANT_ADMIN" || user?.role === "ORG_ADMIN";
}

function getParamId(req: any): string | null {
  const raw = req?.params?.id;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return null;
}

// ✅ ÚJ: egységes “név” parse (body.name vagy body.displayName → DB.displayName)
function parseDisplayName(raw: unknown): string | null | undefined {
  // undefined = nincs a payloadban (nem módosítjuk)
  // null = explicit törlés
  // string = beállítás
  if (typeof raw === "undefined") return undefined;
  if (raw === null) return null;
  if (typeof raw === "string") {
    const v = raw.trim();
    return v ? v : null;
  }
  return undefined;
}

// ✅ ÚJ: API kompatibilitás (a frontendnek legyen name is)
function withNameAlias<T extends { displayName?: any }>(u: T) {
  return { ...u, name: (u as any).displayName ?? null };
}

/**
 * GET /admin/users
 * Tenant-scoped user list.
 *
 * - SUPER_ADMIN: must send x-tenant-id (requireTenant enforces it)
 * - TENANT_ADMIN / ORG_ADMIN: uses token tenantId
 */
router.get("/", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;

    if (!user?.role || !requireAdminReadAccess(user)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (!user.tenantId) {
      return res.status(400).json({ error: "Tenant context required" });
    }

    const users = await prisma.user.findMany({
      where: { tenantId: user.tenantId },
      select: {
        id: true,
        email: true,
        // ✅ ÚJ: név (DB mező)
        displayName: true,
        role: true,
        tenantId: true,
        orgUnitId: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: [{ role: "asc" }, { email: "asc" }],
    });

    // ✅ ÚJ: válaszban legyen "name" is (alias)
    const mapped = users.map(withNameAlias);

    return res.json({ ok: true, users: mapped });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch users" });
  }
});

/**
 * GET /admin/users/:id/messages
 * Tenant-scoped message list for a given user (createdById).
 *
 * Returns:
 * { ok: true, messages: [{ id, createdAt, type, title, scheduledAt, targetType, targetId, status }] }
 *
 * status: derived from linked DeviceCommand statuses for the message:
 *  - FAILED if any command FAILED
 *  - ACKED if any command ACKED
 *  - SENT if any command SENT
 *  - QUEUED if any command QUEUED
 *  - "-" if message has no commands
 */
router.get("/:id/messages", authJwt, requireTenant, async (req, res) => {
  try {
    const actor = (req as any).user as JwtUser;

    if (!actor?.role || !requireAdminReadAccess(actor)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (!actor.tenantId) {
      return res.status(400).json({ error: "Tenant context required" });
    }

    const id = getParamId(req);
    if (!id) return res.status(400).json({ error: "id is required" });

    // Ensure the target user exists in this tenant
    const targetUser = await prisma.user.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: { id: true },
    });

    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    const messages = await prisma.message.findMany({
      where: { tenantId: actor.tenantId, createdById: id },
      select: {
        id: true,
        type: true,
        title: true,
        scheduledAt: true,
        targetType: true,
        targetId: true,
        createdAt: true,
        commands: {
          select: { status: true },
        },
      },
      orderBy: [{ createdAt: "desc" }],
      take: 200,
    });

    const statusRank: Record<string, number> = {
      "-": 0,
      QUEUED: 1,
      SENT: 2,
      ACKED: 3,
      FAILED: 4,
    };

    function aggregateStatus(commandStatuses: Array<{ status: string }>): string {
      if (!commandStatuses || commandStatuses.length === 0) return "-";
      // Pick the "worst"/most informative status by rank:
      // FAILED > ACKED > SENT > QUEUED
      let best = "-";
      for (const cs of commandStatuses) {
        const s = cs.status ?? "-";
        if ((statusRank[s] ?? 0) > (statusRank[best] ?? 0)) best = s;
      }
      return best;
    }

    const mapped = messages.map((m) => ({
      id: m.id,
      createdAt: m.createdAt,
      type: m.type,
      title: m.title,
      scheduledAt: m.scheduledAt,
      targetType: m.targetType,
      targetId: m.targetId,
      status: aggregateStatus(m.commands as Array<{ status: string }>),
    }));

    return res.json({ ok: true, messages: mapped });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch user messages" });
  }
});

/**
 * POST /admin/users
 * Create a tenant-scoped user.
 *
 * Body:
 * {
 *   email: string,
 *   password: string,
 *   role: "TENANT_ADMIN" | "ORG_ADMIN" | "TEACHER" | "OPERATOR" | "PLAYER",
 *   isActive?: boolean,
 *   orgUnitId?: string | null
 *   ✅ + name?: string | null
 *   ✅ + displayName?: string | null
 * }
 */
router.post("/", authJwt, requireTenant, async (req, res) => {
  try {
    const actor = (req as any).user as JwtUser;

    if (!actor?.role || !requireAdminWriteAccess(actor)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (!actor.tenantId) {
      return res.status(400).json({ error: "Tenant context required" });
    }

    const { email, password, role, isActive, orgUnitId, name, displayName } = req.body as {
      email?: unknown;
      password?: unknown;
      role?: unknown;
      isActive?: unknown;
      orgUnitId?: unknown;
      // ✅ ÚJ:
      name?: unknown;
      displayName?: unknown;
    };

    if (typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ error: "email is required" });
    }
    if (typeof password !== "string" || password.length < 6) {
      return res.status(400).json({ error: "password must be at least 6 characters" });
    }
    if (!isTenantRole(role)) {
      return res.status(400).json({ error: "invalid role" });
    }

    let parsedOrgUnitId: string | null | undefined = undefined;
    if (orgUnitId === null) parsedOrgUnitId = null;
    else if (typeof orgUnitId === "string") {
      parsedOrgUnitId = orgUnitId.trim() ? orgUnitId.trim() : null;
    }

    // ✅ ÚJ: név feldolgozása (name vagy displayName)
    const parsedDisplayName =
      typeof displayName !== "undefined" ? parseDisplayName(displayName) : parseDisplayName(name);

    const passwordHash = await bcrypt.hash(password, 10);

    const created = await prisma.user.create({
      data: {
        tenantId: actor.tenantId,
        email: email.trim().toLowerCase(),
        passwordHash,
        role: role as any,
        isActive: typeof isActive === "boolean" ? isActive : true,
        ...(typeof parsedOrgUnitId !== "undefined" ? { orgUnitId: parsedOrgUnitId } : {}),
        ...(typeof parsedDisplayName !== "undefined" ? { displayName: parsedDisplayName } : {}),
      },
      select: {
        id: true,
        email: true,
        // ✅ ÚJ:
        displayName: true,
        role: true,
        tenantId: true,
        orgUnitId: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });

    // ✅ ÚJ: alias
    return res.status(201).json({ ok: true, user: withNameAlias(created) });
  } catch (err: any) {
    if (err?.code === "P2002") {
      return res.status(409).json({ error: "Email already exists" });
    }
    console.error(err);
    return res.status(500).json({ error: "Failed to create user" });
  }
});

/**
 * PATCH /admin/users/:id
 * Update a tenant user (tenant-scoped).
 *
 * Body (partial):
 * {
 *   email?: string,
 *   role?: tenant role,
 *   isActive?: boolean,
 *   password?: string,
 *   orgUnitId?: string | null
 *   ✅ name?: string | null
 *   ✅ displayName?: string | null
 * }
 */
router.patch("/:id", authJwt, requireTenant, async (req, res) => {
  try {
    const actor = (req as any).user as JwtUser;

    if (!actor?.role || !requireAdminWriteAccess(actor)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (!actor.tenantId) {
      return res.status(400).json({ error: "Tenant context required" });
    }

    const id = getParamId(req);
    if (!id) return res.status(400).json({ error: "id is required" });

    const existing = await prisma.user.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: { id: true },
    });

    if (!existing) {
      return res.status(404).json({ error: "User not found" });
    }

    const { email, role, isActive, password, orgUnitId, name, displayName } = req.body as {
      email?: unknown;
      role?: unknown;
      isActive?: unknown;
      password?: unknown;
      orgUnitId?: unknown;
      // ✅ ÚJ:
      name?: unknown;
      displayName?: unknown;
    };

    const data: Record<string, unknown> = {};

    if (typeof email === "string") {
      if (!email.trim()) return res.status(400).json({ error: "email cannot be empty" });
      data.email = email.trim().toLowerCase();
    }

    if (typeof isActive === "boolean") {
      data.isActive = isActive;
    }

    if (typeof role !== "undefined") {
      if (!isTenantRole(role)) return res.status(400).json({ error: "invalid role" });
      data.role = role;
    }

    if (typeof password === "string") {
      const pw = password.trim();
      if (pw) {
        if (pw.length < 6) {
          return res.status(400).json({ error: "password must be at least 6 characters" });
        }
        data.passwordHash = await bcrypt.hash(pw, 10);
      }
    }

    if (typeof orgUnitId !== "undefined") {
      if (orgUnitId === null) data.orgUnitId = null;
      else if (typeof orgUnitId === "string") data.orgUnitId = orgUnitId.trim() ? orgUnitId.trim() : null;
      else return res.status(400).json({ error: "orgUnitId must be string or null" });
    }

    // ✅ ÚJ: displayName kezelése (name/displayName → DB.displayName)
    // Ha bármelyik mezőt elküldik, beállítjuk.
    const parsedDisplayName =
      typeof displayName !== "undefined" ? parseDisplayName(displayName) : parseDisplayName(name);
    if (typeof parsedDisplayName !== "undefined") {
      data.displayName = parsedDisplayName;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "No changes provided" });
    }

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        email: true,
        // ✅ ÚJ:
        displayName: true,
        role: true,
        tenantId: true,
        orgUnitId: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });

    return res.json({ ok: true, user: withNameAlias(updated) });
  } catch (err: any) {
    if (err?.code === "P2002") {
      return res.status(409).json({ error: "Email already exists" });
    }
    console.error(err);
    return res.status(500).json({ error: "Failed to update user" });
  }
});

/**
 * DELETE /admin/users/:id
 *
 * Biztonságos tenant-szintű törlés: soft delete (isActive=false).
 */
router.delete("/:id", authJwt, requireTenant, async (req, res) => {
  try {
    const actor = (req as any).user as JwtUser;

    if (!actor?.role || !requireAdminWriteAccess(actor)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (!actor.tenantId) {
      return res.status(400).json({ error: "Tenant context required" });
    }

    const id = getParamId(req);
    if (!id) return res.status(400).json({ error: "id is required" });

    const existing = await prisma.user.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: { id: true },
    });

    if (!existing) {
      return res.status(404).json({ error: "User not found" });
    }

    await prisma.user.update({
      where: { id },
      data: { isActive: false },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to delete user" });
  }
});

export default router;