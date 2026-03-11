import { Request, Response } from "express";
import * as authService from "./auth.service";

export async function postLogin(req: Request, res: Response) {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });

  const result = await authService.login(String(email), String(password));
  if (!result) return res.status(401).json({ error: "Invalid credentials" });

  // Single session: a felhasználó már be van jelentkezve másik eszközön
  if ("error" in result && result.error === "already_logged_in") {
    return res.status(409).json({ error: "already_logged_in", message: "Ez a felhasználó már be van jelentkezve egy másik eszközön." });
  }

  res.json(result);
}

export async function postLogout(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  await authService.logout(req.user.sub);
  res.status(204).send();
}

export async function getMeHandler(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });

  const me = await authService.getMe(req.user.sub);
  if (!me) return res.status(404).json({ error: "User not found" });

  res.json(me);
}