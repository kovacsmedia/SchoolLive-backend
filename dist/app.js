"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
// src/app.ts
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const auth_routes_1 = require("./modules/auth/auth.routes");
const devices_routes_1 = require("./modules/devices/devices.routes");
const admin_commands_1 = __importDefault(require("./modules/devices/admin.commands"));
const devices_admin_routes_1 = __importDefault(require("./modules/devices/devices.admin.routes"));
const devices_provision_routes_1 = __importDefault(require("./modules/devices/devices.provision.routes"));
const player_device_routes_1 = require("./modules/player/player.device.routes");
const users_admin_routes_1 = __importDefault(require("./modules/users/users.admin.routes"));
const messages_routes_1 = __importDefault(require("./modules/messages/messages.routes"));
const tenants_admin_routes_1 = __importDefault(require("./modules/tenants/tenants.admin.routes"));
const bells_routes_1 = require("./modules/bells/bells.routes");
const radio_routes_1 = __importDefault(require("./modules/radio/radio.routes"));
const contact_routes_1 = __importDefault(require("./modules/contact/contact.routes"));
const authJwt_1 = require("./middleware/authJwt");
const tenant_1 = require("./middleware/tenant");
const prisma_1 = __importDefault(require("./prisma"));
const SyncEngine_1 = require("./sync/SyncEngine");
exports.app = (0, express_1.default)();
const allowedOrigins = ["https://schoollive.hu", "http://localhost:5173"];
const corsOptions = {
    origin(origin, callback) {
        if (!origin)
            return callback(null, true);
        if (allowedOrigins.includes(origin))
            return callback(null, true);
        return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-tenant-id"],
    credentials: false,
};
exports.app.use((0, cors_1.default)(corsOptions));
exports.app.options("*", (0, cors_1.default)(corsOptions));
exports.app.use(express_1.default.json());
exports.app.use(express_1.default.urlencoded({ extended: true, limit: "200mb" }));
// ── Alap health + időszinkron ─────────────────────────────────────────────────
exports.app.get("/health", (_req, res) => res.json({ ok: true }));
/**
 * GET /time
 * Pontos szerveridő visszaadása – a VirtualPlayer Crystal Clock Sync-hez használja.
 * Nincs auth – a minimális válasz késleltetés a cél.
 */
exports.app.get("/time", (_req, res) => {
    // process.hrtime.bigint() nanomásodperces pontossággal
    const now = Date.now();
    res.json({ now, iso: new Date(now).toISOString() });
});
/**
 * GET /sync/status
 * SyncEngine státusz – debug célra, admin auth kell
 */
exports.app.get("/sync/status", authJwt_1.authJwt, (_req, res) => {
    res.json(SyncEngine_1.SyncEngine.getStatus());
});
// ── Route-ok ──────────────────────────────────────────────────────────────────
exports.app.use("/admin/tenants", tenants_admin_routes_1.default);
exports.app.use("/auth", auth_routes_1.authRouter);
exports.app.use("/devices", devices_routes_1.devicesRouter);
exports.app.use("/messages", messages_routes_1.default);
exports.app.use("/admin/commands", admin_commands_1.default);
exports.app.use("/admin/devices", devices_admin_routes_1.default);
exports.app.use("/admin/users", users_admin_routes_1.default);
exports.app.use("/provision", devices_provision_routes_1.default);
exports.app.use("/player/device", player_device_routes_1.playerDeviceRouter);
exports.app.use("/bells", bells_routes_1.bellsRouter);
exports.app.use("/radio", radio_routes_1.default);
exports.app.use("/contact", contact_routes_1.default);
// Statikus fájlok
exports.app.use("/audio/bells", express_1.default.static(path_1.default.join(process.cwd(), "audio", "bells")));
exports.app.use("/audio", express_1.default.static("/opt/schoollive/backend/audio"));
exports.app.use("/uploads/radio", express_1.default.static(path_1.default.join(process.cwd(), "uploads", "radio")));
// ── /bells/today ──────────────────────────────────────────────────────────────
exports.app.get("/bells/today", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const calDay = await prisma_1.default.bellCalendarDay.findUnique({
            where: { tenantId_date: { tenantId, date: today } },
            include: { template: { include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } } } },
        }).catch(() => null);
        if (calDay?.isHoliday)
            return res.json({ ok: true, bells: [], isHoliday: true });
        let bells = [];
        if (calDay?.template?.bells?.length) {
            bells = calDay.template.bells;
        }
        else {
            const def = await prisma_1.default.bellScheduleTemplate.findFirst({
                where: { tenantId, isDefault: true },
                include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } },
            }).catch(() => null);
            bells = def?.bells ?? [];
        }
        return res.json({
            ok: true,
            isHoliday: false,
            bells: bells.map((b) => ({
                hour: b.hour, minute: b.minute, type: b.type, soundFile: b.soundFile,
            })),
        });
    }
    catch (err) {
        console.error("/bells/today error:", err);
        return res.status(500).json({ error: "Failed to fetch today bells" });
    }
});
