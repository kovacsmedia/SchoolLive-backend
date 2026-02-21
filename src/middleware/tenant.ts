import { Request, Response, NextFunction } from "express";

export function requireTenant(req: Request, res: Response, next: NextFunction) {
  // SUPER_ADMIN lehet tenantId nélkül
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });

  if (req.user.role === "SUPER_ADMIN") return next();

  if (!req.user.tenantId) {
    return res.status(403).json({ error: "Tenant context required" });
  }

  next();
}
