import { Request, Response, NextFunction } from "express";
import { findDeviceByKey } from "../modules/devices/device-key";

export async function deviceAuth(req: Request, res: Response, next: NextFunction) {
  const key = req.header("x-device-key");
  if (!key) return res.status(401).json({ error: "Missing device key" });

  // Indexelt feloldás – korábban itt MINDEN KEY-auth eszközre lefutott egy
  // bcrypt.compare (ld. device-key.ts).
  const device = await findDeviceByKey(key, true);
  if (!device) return res.status(401).json({ error: "Invalid device key" });

  (req as any).device = { id: device.id, tenantId: device.tenantId };
  return next();
}
