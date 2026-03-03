import express from "express";
import cors from "cors";

import { authRouter } from "./modules/auth/auth.routes";
import { devicesRouter } from "./modules/devices/devices.routes";
import adminCommandsRouter from "./modules/devices/admin.commands";
import deviceAdminRoutes from "./modules/devices/devices.admin.routes";
import devicesProvisionRouter from "./modules/devices/devices.provision.routes";
import { playerDeviceRouter } from "./modules/player/player.device.routes";

export const app = express();

/**
 * CORS
 * Frontend domain: https://schoollive.hu
 * Dev: http://localhost:5173
 *
 * NOTE: If you use additional domains (www, staging), add them here.
 */
const allowedOrigins = [
  "https://schoollive.hu",
  "http://localhost:5173",
];

app.use(
  cors({
    origin(origin, callback) {
      // allow non-browser requests (curl, server-to-server) with no Origin header
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) return callback(null, true);

      // Reject other origins explicitly
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  })
);

// Handle preflight requests
app.options("*", cors());

app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/devices", devicesRouter);

app.use("/admin/commands", adminCommandsRouter);
app.use("/admin/devices", deviceAdminRoutes);

app.use("/provision", devicesProvisionRouter);

// ✅ web-player mint eszköz
app.use("/player/device", playerDeviceRouter);
//end