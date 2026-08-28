// src/modules/cluster/cluster.admin.routes.ts
//
// SUPER_ADMIN-only diagnosztikai + kezelő végpontok a clusterhez.

import { Router } from "express";
import { prisma } from "../../prisma/client";
import { authJwt } from "../../middleware/authJwt";

const router = Router();

type JwtUser = { sub?: string; role?: string; tenantId?: string | null };

function requireSuperAdmin(user: JwtUser, res: any): boolean {
  if (user?.role !== "SUPER_ADMIN") {
    res.status(403).json({ error: "Forbidden: SUPER_ADMIN only" });
    return false;
  }
  return true;
}

/**
 * GET /admin/cluster/status
 * Node-lista, jelenlegi leader, tenant-eloszlás node-onként.
 */
router.get("/status", authJwt, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!requireSuperAdmin(user, res)) return;

    const [nodes, lease, tenantCounts] = await Promise.all([
      prisma.clusterNode.findMany({ orderBy: { hostname: "asc" } }),
      prisma.clusterLeaderLease.findUnique({
        where: { id: "singleton" },
        include: { leaderNode: { select: { hostname: true } } },
      }),
      prisma.tenant.groupBy({
        by: ["assignedNodeId"],
        where: { isActive: true },
        _count: { _all: true },
      }),
    ]);

    const tenantCountByNode = Object.fromEntries(
      tenantCounts.map((c) => [c.assignedNodeId ?? "unassigned", c._count._all])
    );

    return res.json({
      ok: true,
      nodes,
      leader: lease?.leaderNode?.hostname ?? null,
      leaseExpiresAt: lease?.leaseExpiresAt ?? null,
      tenantCountByNode,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch cluster status" });
  }
});

/**
 * PATCH /admin/cluster/nodes/:id
 * Kézi státuszváltás (pl. ACTIVE <-> DRAINING), hogy egy node "üresen"
 * futhasson, amíg nem akarjuk, hogy a rebalancer tenantot adjon rá.
 */
router.patch("/nodes/:id", authJwt, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!requireSuperAdmin(user, res)) return;

    const { status } = req.body as Record<string, unknown>;
    if (status !== "ACTIVE" && status !== "DRAINING") {
      return res.status(400).json({ error: "status must be ACTIVE or DRAINING" });
    }

    const node = await prisma.clusterNode.update({
      where: { id: String(req.params.id) },
      data: { status },
    });

    return res.json({ ok: true, node });
  } catch (err: any) {
    if (err?.code === "P2025") return res.status(404).json({ error: "Node not found" });
    console.error(err);
    return res.status(500).json({ error: "Failed to update node status" });
  }
});

export default router;
