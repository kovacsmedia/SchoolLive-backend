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
    await SnapcastService.stopRadio(tid);
    return res.json({ ok: true, message: "Rádió leállítva" });
  }
);

// ── POST /snapcast/test-tone ──────────────────────────────────────────────────
router.post(
  "/test-tone",
  authJwt,
  requireSuperAdmin,
  async (req: Request, res: Response) => {
    const tid = getTenantId(req);
    if (!tid) return res.status(400).json({ error: "tenantId query param kötelező" });
    await SnapcastService.play({
      type:     "TTS",
      source:   { type: "url", url: "lavfi:sine=frequency=440:duration=2" },
      tenantId: tid,
      title:    "Test tone 440Hz",
    });
    return res.json({ ok: true, message: "Test tone elindítva" });
  }
);

export default router;