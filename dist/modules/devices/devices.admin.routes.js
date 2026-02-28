"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("../../prisma/client");
const authJwt_1 = require("../../middleware/authJwt");
const router = (0, express_1.Router)();
router.get("/health", authJwt_1.authJwt, async (req, res) => {
    try {
        const user = req.user;
        const whereTenant = user.role === "SUPER_ADMIN"
            ? {}
            : { tenantId: user.tenantId };
        const devices = await client_1.prisma.device.findMany({
            where: whereTenant,
            select: {
                id: true,
                name: true,
                lastSeenAt: true
            }
        });
        const now = Date.now();
        const result = devices.map(d => {
            const secondsSinceLastSeen = d.lastSeenAt
                ? Math.floor((now - new Date(d.lastSeenAt).getTime()) / 1000)
                : null;
            const status = secondsSinceLastSeen !== null && secondsSinceLastSeen < 30
                ? "ONLINE"
                : "OFFLINE";
            return {
                id: d.id,
                name: d.name,
                status,
                secondsSinceLastSeen
            };
        });
        res.json(result);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch device health" });
    }
});
exports.default = router;
