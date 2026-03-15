// src/app.ts
import express from "express";
import cors    from "cors";
import path    from "path";

import { authRouter }           from "./modules/auth/auth.routes";
import { devicesRouter }        from "./modules/devices/devices.routes";
import adminCommandsRouter      from "./modules/devices/admin.commands";
import deviceAdminRoutes        from "./modules/devices/devices.admin.routes";
import devicesProvisionRouter   from "./modules/devices/devices.provision.routes";
import { playerDeviceRouter }   from "./modules/player/player.device.routes";
import usersAdminRoutes         from "./modules/users/users.admin.routes";
import messagesRouter           from "./modules/messages/messages.routes";
import tenantsAdminRouter       from "./modules/tenants/tenants.admin.routes";
import { bellsRouter }          from "./modules/bells/bells.routes";
import radioRoutes              from "./modules/radio/radio.routes";
import contactRouter            from "./modules/contact/contact.routes";
import firmwareRouter           from "./modules/firmware/firmware.routes";
import { authJwt }              from "./middleware/authJwt";
import { requireTenant }        from "./middleware/tenant";
import prisma                   from "./prisma";
import { SyncEngine }           from "./sync/SyncEngine";

export const app = express();

const allowedOrigins = ["https://schoollive.hu", "http://localhost:5173"];

const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods:        ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-tenant-id"],
  credentials:    false,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: "200mb" }));

// ── Alap health + időszinkron ─────────────────────────────────────────────────

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/time", (_req, res) => {
  const now = Date.now();
  res.json({ now, iso: new Date(now).toISOString() });
});

app.get("/sync/status", authJwt, (_req, res) => {
  res.json(SyncEngine.getStatus());
});

// ── Route-ok ──────────────────────────────────────────────────────────────────

app.use("/admin/tenants",  tenantsAdminRouter);
app.use("/auth",           authRouter);
app.use("/devices",        devicesRouter);
app.use("/messages",       messagesRouter);
app.use("/admin/commands", adminCommandsRouter);
app.use("/admin/devices",  deviceAdminRoutes);
app.use("/admin/users",    usersAdminRoutes);
app.use("/provision",      devicesProvisionRouter);
app.use("/player/device",  playerDeviceRouter);
app.use("/bells",          bellsRouter);
app.use("/radio",          radioRoutes);
app.use("/contact",        contactRouter);
app.use("/firmware",       firmwareRouter);

// Statikus fájlok
app.use("/audio/bells",  express.static(path.join(process.cwd(), "audio", "bells")));
app.use("/audio",        express.static("/opt/schoollive/backend/audio"));
app.use("/uploads/radio", express.static(path.join(process.cwd(), "uploads", "radio")));
app.use("/firmware/files", express.static(path.join(process.cwd(), "uploads", "firmware")));

// ── /bells/today ──────────────────────────────────────────────────────────────

app.get("/bells/today", authJwt, requireTenant, async (req, res) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const today    = new Date();
    today.setHours(0, 0, 0, 0);

    const calDay = await (prisma as any).bellCalendarDay.findUnique({
      where:   { tenantId_date: { tenantId, date: today } },
      include: { template: { include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } } } },
    }).catch(() => null);

    if (calDay?.isHoliday) return res.json({ ok: true, bells: [], isHoliday: true });

    let bells: any[] = [];
    if (calDay?.template?.bells?.length) {
      bells = calDay.template.bells;
    } else {
      const def = await (prisma as any).bellScheduleTemplate.findFirst({
        where:   { tenantId, isDefault: true },
        include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } },
      }).catch(() => null);
      bells = def?.bells ?? [];
    }

    return res.json({
      ok:        true,
      isHoliday: false,
      bells:     bells.map((b: any) => ({
        hour: b.hour, minute: b.minute, type: b.type, soundFile: b.soundFile,
      })),
    });
  } catch (err) {
    console.error("/bells/today error:", err);
    return res.status(500).json({ error: "Failed to fetch today bells" });
  }
});