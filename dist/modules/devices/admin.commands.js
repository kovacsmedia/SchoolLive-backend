"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("../../prisma/client");
const authJwt_1 = require("../../middleware/authJwt");
const router = (0, express_1.Router)();
// GET /admin/commands
router.get("/", authJwt_1.authJwt, async (req, res) => {
    try {
        const user = req.user;
        const whereClause = user.role === "SUPER_ADMIN"
            ? {}
            : { tenantId: user.tenantId };
        const commands = await client_1.prisma.deviceCommand.findMany({
            where: whereClause,
            orderBy: {
                queuedAt: "desc"
            },
            take: 100
        });
        const sanitized = commands.map(c => ({
            id: c.id,
            tenantId: c.tenantId,
            deviceId: c.deviceId,
            type: c.payload?.type ?? null,
            status: c.status,
            queuedAt: c.queuedAt,
            sentAt: c.sentAt,
            ackedAt: c.ackedAt,
            retryCount: c.retryCount,
            maxRetries: c.maxRetries,
            lastError: c.lastError
        }));
        res.json({
            ok: true,
            count: sanitized.length,
            commands: sanitized
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({
            ok: false,
            error: "Failed to fetch commands"
        });
    }
});
router.get("/summary", authJwt_1.authJwt, async (req, res) => {
    try {
        const user = req.user;
        const whereClause = user.role === "SUPER_ADMIN"
            ? {}
            : { tenantId: user.tenantId };
        const grouped = await client_1.prisma.deviceCommand.groupBy({
            by: ["status"],
            where: whereClause,
            _count: {
                status: true
            }
        });
        const summary = {};
        grouped.forEach(g => {
            summary[g.status] = g._count.status;
        });
        res.json(summary);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch summary" });
    }
});
exports.default = router;
router.get("/stuck", authJwt_1.authJwt, async (req, res) => {
    try {
        const user = req.user;
        const whereTenant = user.role === "SUPER_ADMIN"
            ? {}
            : { tenantId: user.tenantId };
        const minutes = Number(req.query.minutes ?? 5);
        const threshold = new Date(Date.now() - minutes * 60 * 1000);
        const stuck = await client_1.prisma.deviceCommand.findMany({
            where: {
                ...whereTenant,
                status: "SENT",
                ackedAt: null,
                sentAt: {
                    lt: threshold
                }
            },
            orderBy: {
                sentAt: "asc"
            }
        });
        res.json({
            minutes,
            count: stuck.length,
            commands: stuck.map(c => ({
                id: c.id,
                deviceId: c.deviceId,
                sentAt: c.sentAt,
                retryCount: c.retryCount,
                maxRetries: c.maxRetries,
                lastError: c.lastError
            }))
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch stuck commands" });
    }
});
