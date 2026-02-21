import express from "express";
import { authRouter } from "./modules/auth/auth.routes";
import { devicesRouter } from "./modules/devices/devices.routes";

export const app = express();

app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/devices", devicesRouter);