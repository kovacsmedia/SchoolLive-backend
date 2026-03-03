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
  // Írási műveletekhez:
  // - SUPER_ADMIN: tenant contexttel dolgozhat (x-tenant-id)
  // - TENANT_ADMIN: teljes tenant admin
  // ORG_ADMIN csak olvas (jelenlegi döntés)
  return user?.role === "SUPER_ADMIN" || user?.role === "TENANT_ADMIN";
}

function requireAdminReadAccess(user: JwtUser) {
  // Olvasáshoz:
  return user?.role === "SUPER_ADMIN" || user?.role === "TENANT_ADMIN" || user?.role === "ORG_ADMIN";
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
        name: true,
        role: true,
        tenantId: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: [{ role: "asc" }, { email: "asc" }],
    });

    return res.json({ ok: true, users });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch users" });
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
 *   name?: string | null,
 *   role: "TENANT_ADMIN" | "ORG_ADMIN" | "TEACHER" | "OPERATOR" | "PLAYER",
 *   isActive?: boolean
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

    const { email, password, name, role, isActive } = req.body as {
      email?: unknown;
      password?: unknown;
      name?: unknown;
      role?: unknown;
      isActive?: unknown;
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

    // extra: SUPER_ADMIN nem hozható létre tenant alatt
    if (role === "SUPER_ADMIN") {
      return res.status(400).json({ error: "invalid role" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const created = await prisma.user.create({
      data: {
        tenantId: actor.tenantId,
        email: email.trim().toLowerCase(),
        passwordHash,
        role: role as any,
        name: typeof name === "string" ? name.trim() : name === null ? null : null,
        isActive: typeof isActive === "boolean" ? isActive : true,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        tenantId: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });

    return res.status(201).json({ ok: true, user: created });
  } catch (err: any) {
    // Prisma unique violation (email)
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
 *   name?: string | null,
 *   role?: tenant role,
 *   isActive?: boolean,
 *   password?: string   // optional password reset
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

    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "id is required" });

    const existing = await prisma.user.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: { id: true, tenantId: true, role: true },
    });

    if (!existing) {
      return res.status(404).json({ error: "User not found" });
    }

    const { email, name, role, isActive, password } = req.body as {
      email?: unknown;
      name?: unknown;
      role?: unknown;
      isActive?: unknown;
      password?: unknown;
    };

    const data: any = {};

    if (typeof email === "string") {
      if (!email.trim()) return res.status(400).json({ error: "email cannot be empty" });
      data.email = email.trim().toLowerCase();
    }

    if (name === null) {
      data.name = null;
    } else if (typeof name === "string") {
      data.name = name.trim();
    }

    if (typeof isActive === "boolean") {
      data.isActive = isActive;
    }

    if (typeof role !== "undefined") {
      if (!isTenantRole(role)) return res.status(400).json({ error: "invalid role" });
      data.role = role;
    }

    if (typeof password === "string" && password.trim()) {
      if (password.length < 6) {
        return res.status(400).json({ error: "password must be at least 6 characters" });
      }
      data.passwordHash = await bcrypt.hash(password, 10);
    }

    // nincs módosítható mező
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "No changes provided" });
    }

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        tenantId: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });

    return res.json({ ok: true, user: updated });
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
 * Biztonságos tenant-szintű törlés: soft delete (isActive=false),
 * mert a login is így tilt (auth.service: !user.isActive → null).
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

    const id = req.params.id;
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