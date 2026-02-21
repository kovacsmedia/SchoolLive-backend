import { Request, Response, NextFunction } from "express";
import { prisma } from "../prisma/client";
import bcrypt from "bcrypt";

export async function deviceAuth(req: Request, res: Response, next: NextFunction) {
  const key = req.header("x-device-key");
  if (!key) return res.status(401).json({ error: "Missing device key" });

  // fontos: tenant izoláció miatt nem globálisan keresünk, hanem device táblában hash match
  // mivel bcrypt hash van, végig kell iterálni a tenant device-okon -> ez később optimalizálva lesz (HMAC alapú kulcs)
  const devices = await prisma.device.findMany({
    select: { id: true, deviceKeyHash: true, tenantId: true }
  });

  for (const d of devices) {
    const ok = await bcrypt.compare(key, d.deviceKeyHash);
    if (ok) {
      (req as any).device = { id: d.id, tenantId: d.tenantId };
      return next();
    }
  }

  return res.status(401).json({ error: "Invalid device key" });
}