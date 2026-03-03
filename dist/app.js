"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const client_1 = require("./prisma/client");
const authJwt_1 = require("./middleware/authJwt");
const auth_routes_1 = require("./modules/auth/auth.routes");
const devices_routes_1 = require("./modules/devices/devices.routes");
const admin_commands_1 = __importDefault(require("./modules/devices/admin.commands"));
const devices_admin_routes_1 = __importDefault(require("./modules/devices/devices.admin.routes"));
const devices_provision_routes_1 = __importDefault(require("./modules/devices/devices.provision.routes"));
const player_device_routes_1 = require("./modules/player/player.device.routes");
const users_admin_routes_1 = __importDefault(require("./modules/users/users.admin.routes"));
exports.app = (0, express_1.default)();
/**
 * CORS
 * Frontend domain: https://schoollive.hu
 * Dev: http://localhost:5173
 *
 * NOTE: If you use additional domains (www, staging), add them here.
 */
const allowedOrigins = ["https://schoollive.hu", "http://localhost:5173"];
exports.app.use((0, cors_1.default)({
    origin(origin, callback) {
        // allow non-browser requests (curl, server-to-server) with no Origin header
        if (!origin)
            return callback(null, true);
        if (allowedOrigins.includes(origin))
            return callback(null, true);
        return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-tenant-id"],
    credentials: false,
}));
exports.app.options("*", (0, cors_1.default)());
exports.app.use(express_1.default.json());
exports.app.get("/health", (_req, res) => res.json({ ok: true }));
/**
 * SUPER_ADMIN: tenants list for tenant-switch UI
 * Response shape: [{ id, name, domain, isActive }]
 */
exports.app.get("/admin/tenants", authJwt_1.authJwt, async (req, res) => {
    try {
        const user = req.user;
        if (user?.role !== "SUPER_ADMIN") {
            return res.status(403).json({ error: "Forbidden" });
        }
        const tenants = await client_1.prisma.tenant.findMany({
            select: {
                id: true,
                name: true,
                domain: true,
                isActive: true,
            },
            orderBy: { name: "asc" },
        });
        return res.json({ ok: true, tenants });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to fetch tenants" });
    }
});
// --- ROUTERS ---
exports.app.use("/auth", auth_routes_1.authRouter);
exports.app.use("/devices", devices_routes_1.devicesRouter);
exports.app.use("/admin/commands", admin_commands_1.default);
exports.app.use("/admin/devices", devices_admin_routes_1.default);
exports.app.use("/admin/users", users_admin_routes_1.default);
exports.app.use("/provision", devices_provision_routes_1.default);
// ✅ web-player mint eszköz
exports.app.use("/player/device", player_device_routes_1.playerDeviceRouter);
//end
