import express from "express";

import { authRouter } from "./modules/auth/auth.routes";
import { devicesRouter } from "./modules/devices/devices.routes";
import adminCommandsRouter from "./modules/devices/admin.commands";
import deviceAdminRoutes from "./modules/devices/devices.admin.routes";
import devicesProvisionRouter from "./modules/devices/devices.provision.routes";

export const app = express();

app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/devices", devicesRouter);

app.use("/admin/commands", adminCommandsRouter);
app.use("/admin/devices", deviceAdminRoutes);

app.use("/provision", devicesProvisionRouter);