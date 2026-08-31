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

    // Multi-session enforcement, MINDEN kérésen (nem csak bejelentkezéskor):
    // a token csak akkor érvényes, ha a `sessionId`-jéhez TARTOZIK egy még
    // létező UserSession sor (ld. auth.service.ts login()) – ez ÉLŐBEN tartja
    // a user ÖSSZES párhuzamos kliensét (pl. több teremben futó webplayer),
    // csak az EXPLICIT kijelentkeztetett/törölt session esik ki. Ezzel egy
    // időben lastSeenAt is frissül (egy update-ben).
    //
    // decoded.sessionId hiánya = régi formátumú token (a funkció bevezetése
    // előtt kiadva) – ezt még átengedjük, a köv. login úgyis friss tokent ad.
    if (decoded.sessionId) {
      const r = await prisma.userSession.updateMany({
        where: { sessionId: decoded.sessionId, userId: decoded.sub },
        data:  { lastSeenAt: new Date() },
      });
      if (r.count === 0) {
        return res.status(401).json({
          error:   "session_revoked",
          message: "Ez a munkamenet megszűnt (kijelentkeztetve lett).",
        });
      }
    }

    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}