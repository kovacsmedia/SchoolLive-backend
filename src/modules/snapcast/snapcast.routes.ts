// src/modules/snapcast/snapcast.routes.ts
// Admin és státusz endpointok a Snapcast service-hez.
// Csak SUPER_ADMIN férhet hozzá.

import { Router, Request, Response } from "express";
import { requireAuth, requireRole }  from "../auth/auth.middleware";
import { SnapcastService }           from "./snapcast.service";

const router = Router();

// ── GET /snapcast/status ──────────────────────────────────────────────────────
// Snapserver + service státusz
router.get(
  "/status",
  requireAuth,
  requireRole("SUPER_ADMIN"),
  async (_req: Request, res: Response) => {
    const serviceStatus  = SnapcastService.getStatus();
    const serverOnline   = await SnapcastService.isSnapserverOnline();
    res.json({ ok: true, service: serviceStatus, snapserverOnline: serverOnline });
  }
);

// ── POST /snapcast/stop ───────────────────────────────────────────────────────
// Azonnali leállítás
router.post(
  "/stop",
  requireAuth,
  requireRole("SUPER_ADMIN"),
  (_req: Request, res: Response) => {
    SnapcastService.stop();
    res.json({ ok: true, message: "Snapcast lejátszás leállítva" });
  }
);

// ── POST /snapcast/stop-radio ─────────────────────────────────────────────────
// Csak a rádió leállítása
router.post(
  "/stop-radio",
  requireAuth,
  requireRole("SUPER_ADMIN"),
  (_req: Request, res: Response) => {
    SnapcastService.stopRadio();
    res.json({ ok: true, message: "Rádió leállítva" });
  }
);

// ── POST /snapcast/test-tone ──────────────────────────────────────────────────
// 440Hz szinusz hang 2 másodpercig – kapcsolat teszteléshez
router.post(
  "/test-tone",
  requireAuth,
  requireRole("SUPER_ADMIN"),
  (_req: Request, res: Response) => {
    SnapcastService.play({
      type:     "TTS",
      source:   {
        type: "url",
        // ffmpeg beépített lavfi szinusz generátor
        url: "lavfi:sine=frequency=440:duration=2",
      },
      tenantId: "test",
      title:    "Test tone 440Hz",
    });
    res.json({ ok: true, message: "Test tone elindítva" });
  }
);

export default router;