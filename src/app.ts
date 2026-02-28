import express from "express";
import cors from "cors";

import { authRouter } from "./modules/auth/auth.routes";
import { devicesRouter } from "./modules/devices/devices.routes";
import adminCommandsRouter from "./modules/devices/admin.commands";
import deviceAdminRoutes from "./modules/devices/devices.admin.routes";
import devicesProvisionRouter from "./modules/devices/devices.provision.routes";

export const app = express();

// --- CORS beállítás (UGYANAZT használjuk preflight-ra is) ---
const allowedOrigins = new Set<string>([
  "https://schoollive.hu",
  "https://www.schoollive.hu",
  "http://localhost:5173",
]);

const corsOptions: cors.CorsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl / server-to-server
    if (allowedOrigins.has(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  // credentials: true, // csak akkor kell, ha cookie-s auth lesz
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // <- KRITIKUS: ugyanazokkal a szabályokkal

app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/devices", devicesRouter);
app.use("/admin/commands", adminCommandsRouter);
app.use("/admin/devices", deviceAdminRoutes);
app.use("/provision", devicesProvisionRouter);