import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { JwtPayload } from "../modules/auth/auth.types";
import { prisma } from "../prisma/client";

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export async function authJwt(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!token) return res.status(401).json({ error: "Missing token" });
  if (!env.JWT_ACCESS_SECRET) return res.status(500).json({ error: "JWT secret not set" });

  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;

    // Single-session enforcement, MINDEN kérésen (nem csak bejelentkezéskor):
    // ha időközben valaki (akár ugyanaz a user másik eszközről/böngészőből)
    // helyesen bejelentkezett, az auth.service.ts login() felülírja a
    // User.activeSessionId-t – ez a régi tokent AZONNAL érvénytelenné teszi,
    // nem kell várni a 15 perces TTL-re. Ezzel egy időben lastSeenAt is
    // frissül (egy kérésben, RETURNING-gel).
    const rows = await prisma.$queryRaw<{ activeSessionId: string | null }[]>`
      UPDATE "User" SET "lastSeenAt" = NOW() WHERE id = ${decoded.sub}
      RETURNING "activeSessionId"
    `;
    const currentSessionId = rows[0]?.activeSessionId ?? null;

    // decoded.sessionId hiánya = régi formátumú token (a funkció bevezetése
    // előtt kiadva) – ezt még átengedjük, a session-mezők a legközelebbi
    // login/refresh-kor úgyis frissülnek.
    if (decoded.sessionId && currentSessionId !== decoded.sessionId) {
      return res.status(401).json({
        error:   "session_superseded",
        message: "Ezt a fiókot valaki más helyről jelentkeztette be.",
      });
    }

    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}