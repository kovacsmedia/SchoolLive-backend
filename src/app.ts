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
import clusterAdminRoutes       from "./modules/cluster/cluster.admin.routes";
import { authJwt }              from "./middleware/authJwt";
import prisma                   from "./prisma";
import { SyncEngine }           from "./sync/SyncEngine";
import nativeRoutes from "./modules/devices/devices.native.routes";
export const app = express();

/*
 * Engedélyezett origók.
 *
 * A lista KÖRNYEZETI VÁLTOZÓBÓL BŐVÍTHETŐ (`CORS_ORIGINS`, vesszővel
 * elválasztva) – enélkül minden új telepítés (teszt-példány, másik port,
 * másik domain) kódmódosítást igényelne.
 *
 * FIGYELEM, KÖNNYŰ FÉLREÉRTENI: a böngésző POST/PUT/DELETE kérésnél AKKOR IS
 * küld `Origin` fejlécet, ha a kérés AZONOS ORIGÓRA megy. Tehát hiába szolgálja
 * ki ugyanaz a host és port a felületet és az API-t, az origót akkor is fel
 * kell venni ide – különben a bejelentkezés HTTP 500-zal bukik, miközben a
 * GET-kérések (pl. /health) hibátlanul mennek.
 */
const allowedOrigins = [
  "https://schoollive.hu",
  "http://localhost:5173",
  ...String(process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map(o => o.trim())
    .filter(Boolean),
];

const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(
      `CORS blocked for origin: ${origin} – vedd fel a CORS_ORIGINS env-változóba, ha ez jogos.`));
  },
  methods:        ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-tenant-id"],
  credentials:    false,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
// A rádió-feltöltés korlátja 500 MB (ld. radio.routes.ts) – a body-parser
// korlátja nem lehet kisebb nála. A fájlfeltöltés ugyan multipart, amit a
// multer kezel, de az urlencoded korlát együtt mozogjon vele, hogy ne
// maradjon egy rejtett, kisebb plafon a láncban.
app.use(express.urlencoded({ extended: true, limit: "500mb" }));
app.use("/devices/native", nativeRoutes);

// ── Alap health + időszinkron ─────────────────────────────────────────────────

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/time", (_req, res) => {
  const now = Date.now();
  res.json({ now, iso: new Date(now).toISOString() });
});

app.get("/sync/status", authJwt, (_req, res) => {
  res.json(SyncEngine.getStatus());
});

// Multi-node cluster: melyik node birtokolja jelenleg ezt a tenantot.
// Szándékosan hitelesítés nélküli – bárhonnan ugyanazt a választ adja
// (a közös DB-t olvassa), és egy eszköznek pontosan azért kell hívnia,
// hogy MIELŐTT bármilyen munkamenete lenne a helyes node-on, megtudja
// hova kapcsolódjon. Melyik node "birtokol" egy tenantot nem érzékeny adat.
app.get("/cluster/locate", async (req, res) => {
  const tenantId = String(req.query.tenantId ?? "");
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { assignedNode: { select: { hostname: true } } },
  });
  if (!tenant?.assignedNode) return res.status(404).json({ error: "Not found" });

  return res.json({ hostname: tenant.assignedNode.hostname });
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
app.use("/admin/cluster",  clusterAdminRoutes);

// Statikus fájlok
app.use("/audio/bells",  express.static(path.join(process.cwd(), "audio", "bells")));
/*
 * A TÖBBIVEL AZONOS MÓDON, `process.cwd()`-ből.
 *
 * Itt korábban a bedrótozott `/opt/schoollive/backend/audio` állt. Az éles
 * node-on véletlenül stimmelt, de bárhol máshol (teszt-példány, másik
 * telepítési útvonal, fejlesztői futtatás) az üzenet-hangok és a TTS-kimenet
 * NÉMÁN 404-et adott – a felület lejátszója 0:00-t mutatott.
 */
app.use("/audio",        express.static(path.join(process.cwd(), "audio")));
app.use("/uploads/radio", express.static(path.join(process.cwd(), "uploads", "radio")));
app.use("/firmware/files", express.static(path.join(process.cwd(), "uploads", "firmware")));

// ── /bells/today ──────────────────────────────────────────────────────────────
//
// ELTÁVOLÍTVA. Itt korábban egy `app.get("/bells/today", authJwt, requireTenant, …)`
// állt, ami SOSEM futott le: az `app.use("/bells", bellsRouter)` fentebb van
// regisztrálva, és az Express a sorrend szerint az első illeszkedő kezelőt
// hívja – tehát mindig a router `/today` végpontja válaszolt. A route mostantól
// egy helyen él, a bells.routes.ts-ben, ott kapott rendes hitelesítést
// (device-kulcs VAGY JWT+requireTenant).
