// src/modules/tenants/tenants.admin.routes.ts

import { Router } from "express";
import { prisma } from "../../prisma/client";
import { authJwt } from "../../middleware/authJwt";

const router = Router();

type JwtUser = {
  sub?: string;
  role?: string;
  tenantId?: string | null;
};

function requireSuperAdmin(user: JwtUser, res: any): boolean {
  if (user?.role !== "SUPER_ADMIN") {
    res.status(403).json({ error: "Forbidden: SUPER_ADMIN only" });
    return false;
  }
  return true;
}

const SELECT = {
  id: true,
  name: true,
  domain: true,
  isActive: true,
  createdAt: true,
  address: true,
  directorName: true,
  directorPhone: true,
  directorEmail: true,
  eduId: true,
} as const;

/**
 * GET /admin/tenants
 * Lista – már létezett az app.ts-ben, azt kiváltja ez a router
 */
router.get("/", authJwt, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!requireSuperAdmin(user, res)) return;

    const tenants = await prisma.tenant.findMany({
      select: SELECT,
      orderBy: { name: "asc" },
    });

    return res.json({ ok: true, tenants });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch tenants" });
  }
});

/**
 * POST /admin/tenants
 * Új tenant létrehozása
 */
router.post("/", authJwt, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!requireSuperAdmin(user, res)) return;

    const { name, domain, isActive, address, directorName, directorPhone, directorEmail, eduId } =
      req.body as Record<string, unknown>;

    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }

    const created = await prisma.tenant.create({
      data: {
        name: name.trim(),
        domain: typeof domain === "string" && domain.trim() ? domain.trim() : null,
        isActive: typeof isActive === "boolean" ? isActive : true,
        address: typeof address === "string" && address.trim() ? address.trim() : null,
        directorName: typeof directorName === "string" && directorName.trim() ? directorName.trim() : null,
        directorPhone: typeof directorPhone === "string" && directorPhone.trim() ? directorPhone.trim() : null,
        directorEmail: typeof directorEmail === "string" && directorEmail.trim() ? directorEmail.trim() : null,
        eduId: typeof eduId === "string" && eduId.trim() ? eduId.trim() : null,
      },
      select: SELECT,
    });

    return res.status(201).json({ ok: true, tenant: created });
  } catch (err: any) {
    if (err?.code === "P2002") {
      return res.status(409).json({ error: "Domain already exists" });
    }
    console.error(err);
    return res.status(500).json({ error: "Failed to create tenant" });
  }
});

/**
 * PATCH /admin/tenants/:id
 * Tenant módosítása
 */
router.patch("/:id", authJwt, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!requireSuperAdmin(user, res)) return;

    const id = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id)?.trim();    if (!id) return res.status(400).json({ error: "id is required" });

    const existing = await prisma.tenant.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return res.status(404).json({ error: "Tenant not found" });

    const { name, domain, isActive, address, directorName, directorPhone, directorEmail, eduId } =
      req.body as Record<string, unknown>;

    const data: Record<string, unknown> = {};

    if (typeof name === "string") {
      if (!name.trim()) return res.status(400).json({ error: "name cannot be empty" });
      data.name = name.trim();
    }
    if (typeof domain !== "undefined") {
      data.domain = typeof domain === "string" && domain.trim() ? domain.trim() : null;
    }
    if (typeof isActive === "boolean") data.isActive = isActive;
    if (typeof address !== "undefined") {
      data.address = typeof address === "string" && address.trim() ? address.trim() : null;
    }
    if (typeof directorName !== "undefined") {
      data.directorName = typeof directorName === "string" && directorName.trim() ? directorName.trim() : null;
    }
    if (typeof directorPhone !== "undefined") {
      data.directorPhone = typeof directorPhone === "string" && directorPhone.trim() ? directorPhone.trim() : null;
    }
    if (typeof directorEmail !== "undefined") {
      data.directorEmail = typeof directorEmail === "string" && directorEmail.trim() ? directorEmail.trim() : null;
    }
    if (typeof eduId !== "undefined") {
      data.eduId = typeof eduId === "string" && eduId.trim() ? eduId.trim() : null;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "No changes provided" });
    }

    const updated = await prisma.tenant.update({
      where: { id },
      data,
      select: SELECT,
    });

    return res.json({ ok: true, tenant: updated });
  } catch (err: any) {
    if (err?.code === "P2002") {
      return res.status(409).json({ error: "Domain already exists" });
    }
    console.error(err);
    return res.status(500).json({ error: "Failed to update tenant" });
  }
});

/**
 * DELETE /admin/tenants/:id
 * Soft delete: isActive = false
 */
router.delete("/:id", authJwt, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!requireSuperAdmin(user, res)) return;

    const id = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id)?.trim();    if (!id) return res.status(400).json({ error: "id is required" });

    const existing = await prisma.tenant.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return res.status(404).json({ error: "Tenant not found" });

    await prisma.tenant.update({ where: { id }, data: { isActive: false } });

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to deactivate tenant" });
  }
});

export default router;