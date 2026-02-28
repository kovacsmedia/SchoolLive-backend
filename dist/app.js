"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const auth_routes_1 = require("./modules/auth/auth.routes");
const devices_routes_1 = require("./modules/devices/devices.routes");
const admin_commands_1 = __importDefault(require("./modules/devices/admin.commands"));
const devices_admin_routes_1 = __importDefault(require("./modules/devices/devices.admin.routes"));
const devices_provision_routes_1 = __importDefault(require("./modules/devices/devices.provision.routes"));
exports.app = (0, express_1.default)();
// --- CORS beállítás ---
const allowedOrigins = new Set([
    "https://schoollive.hu",
    "https://www.schoollive.hu",
    "http://localhost:5173", // dev frontend
]);
exports.app.use((0, cors_1.default)({
    origin: (origin, cb) => {
        if (!origin)
            return cb(null, true); // curl / server-to-server
        if (allowedOrigins.has(origin))
            return cb(null, true);
        return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));
// Preflight támogatás
exports.app.options("*", (0, cors_1.default)());
exports.app.use(express_1.default.json());
exports.app.get("/health", (_req, res) => res.json({ ok: true }));
exports.app.use("/auth", auth_routes_1.authRouter);
exports.app.use("/devices", devices_routes_1.devicesRouter);
exports.app.use("/admin/commands", admin_commands_1.default);
exports.app.use("/admin/devices", devices_admin_routes_1.default);
exports.app.use("/provision", devices_provision_routes_1.default);
