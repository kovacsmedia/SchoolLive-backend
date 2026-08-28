// src/modules/snapcast/snapcast.routes.ts
// Admin és státusz endpointok a Snapcast service-hez.
// Csak SUPER_ADMIN férhet hozzá.
// tenantId query param kötelező (pl. ?tenantId=xxx) – multi-tenant

import { Router, Request, Response } from "express";
import { authJwt }         from "../../middleware/authJwt";
import { SnapcastService } from "./snapcast.service";

const requireSuperAdmin = (req: Request, res: Response, next: Function) => {
  const user = (req as any).user;
  if (user?.role !== "SUPER_ADMIN") return res.status(403).json({ error: "Forbidden" });
  next();
};

function getTenantId(req: Request): string | null {
  return (req.query.tenantId as string) || null;
}

// Multi-node cluster: ezek a route-ok NEM mennek át a requireTenant
// middleware-en (query paramból olvassák a tenantId-t, nem a JWT-ből), ezért
// itt külön kell ellenőrizni a tulajdonjogot. A SnapcastService.getEngine()
// már eleve elutasítja a nem-saját tenantot (safe no-op), de admin
// diagnosztikai route-oknál egyértelmű 409 hasznosabb, mint egy csendes
// "sikeres" válasz, ami valójában nem csinált semmit.
async function checkOwnershipOrRespond(tenantId: string, res: Response): Promise<boolean> {
  const { isOwnedByThisNode } = await import("../cluster/tenant-ownership");
  if (isOwnedByThisNode(tenantId)) return true;

  const { prisma } = await import("../../prisma/client");
  const { env } = await import("../../config/env");
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { assignedNode: { select: { hostname: true } } },
  });
  res.status(409).json({
    error: "Tenant not hosted on this node",
    correctNodeHostname: tenant?.assignedNode?.hostname ?? null,
  });
  return false;
}

const router = Router();

// ── GET /snapcast/status ──────────────────────────────────────────────────────
// Összes tenant státusza, vagy egy adott tenant ha ?tenantId=xxx
router.get(
  "/status",
  authJwt,
  requireSuperAdmin,
  async (req: Request, res: Response) => {
    const tid = getTenantId(req);
    if (tid) {
      if (!(await checkOwnershipOrRespond(tid, res))) return;
      const serviceStatus = SnapcastService.getStatus(tid);
      const serverOnline  = await SnapcastService.isSnapserverOnline(tid);
      return res.json({ ok: true, service: serviceStatus, snapserverOnline: serverOnline });
    }
    // Összes tenant
    const allStatus = SnapcastService.getAllStatus();
    return res.json({ ok: true, tenants: allStatus });
  }
);

// ── POST /snapcast/stop ───────────────────────────────────────────────────────
router.post(
  "/stop",
  authJwt,
  requireSuperAdmin,
  async (req: Request, res: Response) => {
    const tid = getTenantId(req);
    if (!tid) return res.status(400).json({ error: "tenantId query param kötelező" });
    if (!(await checkOwnershipOrRespond(tid, res))) return;
    await SnapcastService.stop(tid);
    return res.json({ ok: true, message: "Snapcast lejátszás leállítva" });
  }
);

// ── POST /snapcast/stop-radio ─────────────────────────────────────────────────
router.post(
  "/stop-radio",
  authJwt,
  requireSuperAdmin,
  async (req: Request, res: Response) => {
    const tid = getTenantId(req);
    if (!tid) return res.status(400).json({ error: "tenantId query param kötelező" });
    if (!(await checkOwnershipOrRespond(tid, res))) return;
    await SnapcastService.stopRadio(tid);
    return res.json({ ok: true, message: "Rádió leállítva" });
  }
);

// ── POST /snapcast/test-tone ──────────────────────────────────────────────────
// Minden tenant-eszközt unmutál a teszthez (admin csak).
router.post(
  "/test-tone",
  authJwt,
  requireSuperAdmin,
  async (req: Request, res: Response) => {
    const tid = getTenantId(req);
    if (!tid) return res.status(400).json({ error: "tenantId query param kötelező" });
    if (!(await checkOwnershipOrRespond(tid, res))) return;
    const { prisma } = await import("../../prisma/client");
    const allIds = (await prisma.device.findMany({
      where: { tenantId: tid }, select: { id: true },
    })).map(d => d.id);
    await SnapcastService.play({
      type:               "TTS",
      source:             { type: "url", url: "lavfi:sine=frequency=440:duration=2" },
      tenantId:           tid,
      title:              "Test tone 440Hz",
      deviceIdsToUnmute:  allIds,
    });
    return res.json({ ok: true, message: "Test tone elindítva", devices: allIds.length });
  }
);

export default router;