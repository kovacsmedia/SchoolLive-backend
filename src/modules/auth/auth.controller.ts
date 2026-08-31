import { Request, Response } from "express";
import * as authService from "./auth.service";
import { SUPPORTED_LOCALES } from "../../config/env";

export async function postLogin(req: Request, res: Response) {
  const { email, password, clientKey } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });

  // clientKey: a frontend localStorage-ban tárolt, böngészőnként stabil
  // azonosítója (ld. src/lib/clientKey.ts) – a bejelentkezett kliensek
  // listájában ez alapján tudjuk megkülönböztetni "ezt a gépet" a többitől.
  const result = await authService.login(String(email), String(password), {
    clientKey: typeof clientKey === "string" && clientKey.trim() ? clientKey.trim().slice(0, 200) : null,
    userAgent: (req.headers["user-agent"] ?? null) as string | null,
    ipAddress: req.ip ?? null,
  });
  if (!result) return res.status(401).json({ error: "Invalid credentials" });

  // Helyes jelszó = mindig azonnali belépés, ÚJ kliensként (ld.
  // auth.service.ts login()) – a user esetleges többi aktív munkamenete
  // (pl. másik teremben futó webplayer) ettől NEM szűnik meg.
  res.json(result);
}

export async function postLogout(req: Request, res: Response) {
  // sendBeacon nem tud Authorization headert küldeni,
  // ezért a tokent body-ból is elfogadjuk
  let userId = req.user?.sub;
  let sessionId = req.user?.sessionId;

  if (!userId) {
    const bodyToken = req.body?.token ?? req.body?.accessToken ?? "";
    if (bodyToken) {
      try {
        const jwt = await import("jsonwebtoken");
        const { env } = await import("../../config/env");
        // ignoreExpiration: a logout akkor is sikerüljön (törölje a
        // munkamenetet), ha a token időközben lejárt – pl. a user
        // inaktívan hagyta a fület, a token 15 perc után lejárt, és csak
        // EZUTÁN kattint kijelentkezésre / zárja be a fület (sendBeacon).
        const decoded = jwt.default.verify(bodyToken, env.JWT_ACCESS_SECRET, { ignoreExpiration: true }) as any;
        userId = decoded.sub;
        sessionId = decoded.sessionId;
      } catch {}
    }
  }

  if (!userId) return res.status(204).send(); // silent – ne blokkoljuk
  // FONTOS: csak a HÍVÓ SAJÁT sessionId-je szűnik meg – a user esetleges
  // többi aktív kliense (pl. másik teremben futó webplayer) érintetlen.
  await authService.logout(userId, sessionId);
  res.status(204).send();
}

export async function postRefresh(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const result = await authService.refresh(req.user);
  res.json(result);
}

export async function getMeHandler(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });

  const me = await authService.getMe(req.user.sub);
  if (!me) return res.status(404).json({ error: "User not found" });

  res.json(me);
}

// GET /auth/sessions – a hívó SAJÁT bejelentkezett kliensei (self-service
// lista: pl. egy admin láthatja, hány böngészőből/eszközről van bejelentkezve
// ugyanazzal a fiókkal).
export async function getSessionsHandler(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });

  const sessions = await authService.listSessions(req.user.sub);
  res.json({
    ok: true,
    sessions: sessions.map(({ sessionId, ...s }) => ({
      ...s,
      isCurrent: sessionId === req.user!.sessionId,
    })),
  });
}

// DELETE /auth/sessions/:id – egy konkrét SAJÁT munkamenet kényszerített
// megszüntetése (pl. egy elfelejtve nyitva hagyott böngésző kijelentkeztetése
// egy másik eszközről).
export async function deleteSessionHandler(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });

  const id = String(req.params.id ?? "");
  if (!id) return res.status(400).json({ error: "Missing id" });

  const ok = await authService.revokeSession(req.user.sub, id);
  if (!ok) return res.status(404).json({ error: "Session not found" });
  res.status(204).send();
}

export async function patchMeLocale(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });

  const locale = req.body?.locale;
  if (typeof locale !== "string" || !SUPPORTED_LOCALES.includes(locale as any)) {
    return res.status(400).json({ error: `locale must be one of: ${SUPPORTED_LOCALES.join(", ")}` });
  }

  const updated = await authService.setLocale(req.user.sub, locale);
  res.json({ ok: true, locale: updated.locale });
}