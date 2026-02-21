import { Request, Response } from "express";
import * as authService from "./auth.service";

export async function postLogin(req: Request, res: Response) {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });

  const result = await authService.login(String(email), String(password));
  if (!result) return res.status(401).json({ error: "Invalid credentials" });

  res.json(result);
}

export async function getMeHandler(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });

  const me = await authService.getMe(req.user.sub);
  if (!me) return res.status(404).json({ error: "User not found" });

  res.json(me);
}
