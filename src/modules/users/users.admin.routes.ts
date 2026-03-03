import { Router } from "express";
import { prisma } from "../../prisma/client";
import { authJwt } from "../../middleware/authJwt";
import { requireTenant } from "../../middleware/tenant";

const router = Router();

/**
 * GET /admin/users
 * Tenant-scoped user list.
 *
 * - SUPER_ADMIN: must send x-tenant-id (requireTenant enforces it)
 * - TENANT_ADMIN / ORG_ADMIN: uses token tenantId
 */
router.get("/", authJwt, requireTenant, async (req, res) => {
  try {
    const user = (req as any).user as { role?: string; tenantId?: string | null };

    // Minimal role gate (bővíthető)
    if (!user?.role || !["SUPER_ADMIN", "TENANT_ADMIN", "ORG_ADMIN"].includes(user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (!user.tenantId) {
      // requireTenant should prevent this, but keep it defensive
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
      },
      orderBy: [{ role: "asc" }, { email: "asc" }],
    });

    return res.json({ ok: true, users });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch users" });
  }
});

export default router;