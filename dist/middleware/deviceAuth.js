"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deviceAuth = deviceAuth;
const client_1 = require("../prisma/client");
const bcrypt_1 = __importDefault(require("bcrypt"));
async function deviceAuth(req, res, next) {
    const key = req.header("x-device-key");
    if (!key)
        return res.status(401).json({ error: "Missing device key" });
    // ✅ csak KEY authType device-okra próbálunk
    const devices = await client_1.prisma.device.findMany({
        where: { authType: "KEY" },
        select: { id: true, deviceKeyHash: true, tenantId: true },
    });
    for (const d of devices) {
        if (!d.deviceKeyHash)
            continue; // safety
        const ok = await bcrypt_1.default.compare(key, d.deviceKeyHash);
        if (ok) {
            req.device = { id: d.id, tenantId: d.tenantId };
            return next();
        }
    }
    return res.status(401).json({ error: "Invalid device key" });
}
