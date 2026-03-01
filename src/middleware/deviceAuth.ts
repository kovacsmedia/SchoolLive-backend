import { Request, Response, NextFunction } from "express";
import { prisma } from "../prisma/client";
import bcrypt from "bcrypt";

export async function deviceAuth(req: Request, res: Response, next: NextFunction) {
  const key = req.header("x-device-key");
  if (!key) return res.status(401).json({ error: "Missing device key" });

  // ✅ csak KEY authType device-okra próbálunk
  const devices = await prisma.device.findMany({
    where: { authType: "KEY" },
    select: { id: true, deviceKeyHash: true, tenantId: true },
  });

  for (const d of devices) {
    if (!d.deviceKeyHash) continue; // safety
    const ok = await bcrypt.compare(key, d.deviceKeyHash);
    if (ok) {
      (req as any).device = { id: d.id, tenantId: d.tenantId };
      return next();
    }
  }

  return res.status(401).json({ error: "Invalid device key" });
}