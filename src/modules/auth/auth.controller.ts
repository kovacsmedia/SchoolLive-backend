import { Request, Response } from "express";
import * as authService from "./auth.service";
import { SUPPORTED_LOCALES } from "../../config/env";

export async function postLogin(req: Request, res: Response) {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });

  const result = await authService.login(String(email), String(password));
  if (!result) return res.status(401).json({ error: "Invalid credentials" });

  // Helyes jelszó = mindig azonnali belépés (ld. auth.service.ts login()) –
  // a régi session máshol a authJwt middleware-en keresztül szűnik meg a
  // következő kérésénél, nincs itt elutasítandó eset.
  res.json(result);
}

export async function postLogout(req: Request, res: Response) {
  // sendBeacon nem tud Authorization headert küldeni,
  // ezért a tokent body-ból is elfogadjuk
  let userId = req.user?.sub;

  if (!userId) {
    const bodyToken = req.body?.token ?? req.body?.accessToken ?? "";
    if (bodyToken) {
      try {
        const jwt = await import("jsonwebtoken");
        const { env } = await import("../../config/env");
        // ignoreExpiration: a logout akkor is sikerüljön (törölje az
        // activeSessionId-t), ha a token időközben lejárt – pl. a user
        // inaktívan hagyta a fület, a token 15 perc után lejárt, és csak
        // EZUTÁN kattint kijelentkezésre / zárja be a fület (sendBeacon).
        // (Már nem kritikus a re-login szempontjából, mert a login() mindig
        // azonnal beenged – de a activeSessionId takarítása így is helyes.)
        const decoded = jwt.default.verify(bodyToken, env.JWT_ACCESS_SECRET, { ignoreExpiration: true }) as any;
        userId = decoded.sub;
      } catch {}
    }
  }

  if (!userId) return res.status(204).send(); // silent – ne blokkoljuk
  await authService.logout(userId);
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

export async function patchMeLocale(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });

  const locale = req.body?.locale;
  if (typeof locale !== "string" || !SUPPORTED_LOCALES.includes(locale as any)) {
    return res.status(400).json({ error: `locale must be one of: ${SUPPORTED_LOCALES.join(", ")}` });
  }

  const updated = await authService.setLocale(req.user.sub, locale);
  res.json({ ok: true, locale: updated.locale });
}