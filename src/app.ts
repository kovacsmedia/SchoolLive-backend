import express from "express";
import cors from "cors";
import path from "path";

import { authRouter } from "./modules/auth/auth.routes";
import { devicesRouter } from "./modules/devices/devices.routes";
import adminCommandsRouter from "./modules/devices/admin.commands";
import deviceAdminRoutes from "./modules/devices/devices.admin.routes";
import devicesProvisionRouter from "./modules/devices/devices.provision.routes";
import { playerDeviceRouter } from "./modules/player/player.device.routes";
import usersAdminRoutes from "./modules/users/users.admin.routes";
import messagesRouter from "./modules/messages/messages.routes";
import tenantsAdminRouter from "./modules/tenants/tenants.admin.routes";
import { bellsRouter } from "./modules/bells/bells.routes";

export const app = express();

const allowedOrigins = ["https://schoollive.hu", "http://localhost:5173"];

const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-tenant-id"],
  credentials: false,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/admin/tenants", tenantsAdminRouter);
app.use("/auth", authRouter);
app.use("/devices", devicesRouter);
app.use("/messages", messagesRouter);
app.use("/audio/bells", express.static(path.join(process.cwd(), "audio", "bells")));
app.use("/audio", express.static("/opt/schoollive/backend/audio"));
app.use("/admin/commands", adminCommandsRouter);
app.use("/admin/devices", deviceAdminRoutes);
app.use("/admin/users", usersAdminRoutes);
app.use("/provision", devicesProvisionRouter);
app.use("/player/device", playerDeviceRouter);
app.use("/bells", bellsRouter);