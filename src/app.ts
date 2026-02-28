import express from "express";
import cors from "cors";

import { authRouter } from "./modules/auth/auth.routes";
import { devicesRouter } from "./modules/devices/devices.routes";
import adminCommandsRouter from "./modules/devices/admin.commands";
import deviceAdminRoutes from "./modules/devices/devices.admin.routes";
import devicesProvisionRouter from "./modules/devices/devices.provision.routes";

export const app = express();

// --- CORS beállítás ---
const allowedOrigins = new Set<string>([
  "https://schoollive.hu",
  "https://www.schoollive.hu",
  "http://localhost:5173", // dev frontend
]);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl / server-to-server
      if (allowedOrigins.has(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Preflight támogatás
app.options("*", cors());

app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/devices", devicesRouter);
app.use("/admin/commands", adminCommandsRouter);
app.use("/admin/devices", deviceAdminRoutes);
app.use("/provision", devicesProvisionRouter);
app.get("/health", (_req, res) => res.set("X-SchoolLive-Build", "cors-1").json({ ok: true }));