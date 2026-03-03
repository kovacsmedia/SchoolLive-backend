"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("../../prisma/client");
const authJwt_1 = require("../../middleware/authJwt");
const tenant_1 = require("../../middleware/tenant");
// ⚠️ Ha nálatok bcryptjs van, cseréld erre:
// import bcrypt from "bcryptjs";
const bcrypt_1 = __importDefault(require("bcrypt"));
const router = (0, express_1.Router)();
const ALLOWED_TENANT_ROLES = ["TENANT_ADMIN", "ORG_ADMIN", "TEACHER", "OPERATOR", "PLAYER"];
function isTenantRole(x) {
    return typeof x === "string" && ALLOWED_TENANT_ROLES.includes(x);
}
function requireAdminWriteAccess(user) {
    // Írási műveletek:
    // - SUPER_ADMIN: tenant contexttel (x-tenant-id + requireTenant)
    // - TENANT_ADMIN: tenant admin
    return user?.role === "SUPER_ADMIN" || user?.role === "TENANT_ADMIN";
}
function requireAdminReadAccess(user) {
    // Olvasáshoz:
    return user?.role === "SUPER_ADMIN" || user?.role === "TENANT_ADMIN" || user?.role === "ORG_ADMIN";
}
function getParamId(req) {
    const raw = req?.params?.id;
    if (typeof raw === "string" && raw.trim())
        return raw.trim();
    return null;
}
/**
 * GET /admin/users
 * Tenant-scoped user list.
 *
 * - SUPER_ADMIN: must send x-tenant-id (requireTenant enforces it)
 * - TENANT_ADMIN / ORG_ADMIN: uses token tenantId
 */
router.get("/", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        const user = req.user;
        if (!user?.role || !requireAdminReadAccess(user)) {
            return res.status(403).json({ error: "Forbidden" });
        }
        if (!user.tenantId) {
            return res.status(400).json({ error: "Tenant context required" });
        }
        const users = await client_1.prisma.user.findMany({
            where: { tenantId: user.tenantId },
            select: {
                id: true,
                email: true,
                role: true,
                tenantId: true,
                orgUnitId: true,
                isActive: true,
                lastLoginAt: true,
                createdAt: true,
            },
            orderBy: [{ role: "asc" }, { email: "asc" }],
        });
        return res.json({ ok: true, users });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to fetch users" });
    }
});
/**
 * GET /admin/users/:id/messages
 * Tenant-scoped message list for a given user (createdById).
 *
 * Returns:
 * { ok: true, messages: [{ id, createdAt, type, title, scheduledAt, targetType, targetId, status }] }
 *
 * status: derived from linked DeviceCommand statuses for the message:
 *  - FAILED if any command FAILED
 *  - ACKED if any command ACKED
 *  - SENT if any command SENT
 *  - QUEUED if any command QUEUED
 *  - "-" if message has no commands
 */
router.get("/:id/messages", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        const actor = req.user;
        if (!actor?.role || !requireAdminReadAccess(actor)) {
            return res.status(403).json({ error: "Forbidden" });
        }
        if (!actor.tenantId) {
            return res.status(400).json({ error: "Tenant context required" });
        }
        const id = getParamId(req);
        if (!id)
            return res.status(400).json({ error: "id is required" });
        // Ensure the target user exists in this tenant
        const targetUser = await client_1.prisma.user.findFirst({
            where: { id, tenantId: actor.tenantId },
            select: { id: true },
        });
        if (!targetUser) {
            return res.status(404).json({ error: "User not found" });
        }
        const messages = await client_1.prisma.message.findMany({
            where: { tenantId: actor.tenantId, createdById: id },
            select: {
                id: true,
                type: true,
                title: true,
                scheduledAt: true,
                targetType: true,
                targetId: true,
                createdAt: true,
                commands: {
                    select: { status: true },
                },
            },
            orderBy: [{ createdAt: "desc" }],
            take: 200,
        });
        const statusRank = {
            "-": 0,
            QUEUED: 1,
            SENT: 2,
            ACKED: 3,
            FAILED: 4,
        };
        function aggregateStatus(commandStatuses) {
            if (!commandStatuses || commandStatuses.length === 0)
                return "-";
            // Pick the "worst"/most informative status by rank:
            // FAILED > ACKED > SENT > QUEUED
            let best = "-";
            for (const cs of commandStatuses) {
                const s = cs.status ?? "-";
                if ((statusRank[s] ?? 0) > (statusRank[best] ?? 0))
                    best = s;
            }
            return best;
        }
        const mapped = messages.map((m) => ({
            id: m.id,
            createdAt: m.createdAt,
            type: m.type,
            title: m.title,
            scheduledAt: m.scheduledAt,
            targetType: m.targetType,
            targetId: m.targetId,
            status: aggregateStatus(m.commands),
        }));
        return res.json({ ok: true, messages: mapped });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to fetch user messages" });
    }
});
/**
 * POST /admin/users
 * Create a tenant-scoped user.
 *
 * Body:
 * {
 *   email: string,
 *   password: string,
 *   role: "TENANT_ADMIN" | "ORG_ADMIN" | "TEACHER" | "OPERATOR" | "PLAYER",
 *   isActive?: boolean,
 *   orgUnitId?: string | null
 * }
 */
router.post("/", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        const actor = req.user;
        if (!actor?.role || !requireAdminWriteAccess(actor)) {
            return res.status(403).json({ error: "Forbidden" });
        }
        if (!actor.tenantId) {
            return res.status(400).json({ error: "Tenant context required" });
        }
        const { email, password, role, isActive, orgUnitId } = req.body;
        if (typeof email !== "string" || !email.trim()) {
            return res.status(400).json({ error: "email is required" });
        }
        if (typeof password !== "string" || password.length < 6) {
            return res.status(400).json({ error: "password must be at least 6 characters" });
        }
        if (!isTenantRole(role)) {
            return res.status(400).json({ error: "invalid role" });
        }
        let parsedOrgUnitId = undefined;
        if (orgUnitId === null)
            parsedOrgUnitId = null;
        else if (typeof orgUnitId === "string") {
            parsedOrgUnitId = orgUnitId.trim() ? orgUnitId.trim() : null;
        }
        const passwordHash = await bcrypt_1.default.hash(password, 10);
        const created = await client_1.prisma.user.create({
            data: {
                tenantId: actor.tenantId,
                email: email.trim().toLowerCase(),
                passwordHash,
                role: role,
                isActive: typeof isActive === "boolean" ? isActive : true,
                ...(typeof parsedOrgUnitId !== "undefined" ? { orgUnitId: parsedOrgUnitId } : {}),
            },
            select: {
                id: true,
                email: true,
                role: true,
                tenantId: true,
                orgUnitId: true,
                isActive: true,
                lastLoginAt: true,
                createdAt: true,
            },
        });
        return res.status(201).json({ ok: true, user: created });
    }
    catch (err) {
        if (err?.code === "P2002") {
            return res.status(409).json({ error: "Email already exists" });
        }
        console.error(err);
        return res.status(500).json({ error: "Failed to create user" });
    }
});
/**
 * PATCH /admin/users/:id
 * Update a tenant user (tenant-scoped).
 *
 * Body (partial):
 * {
 *   email?: string,
 *   role?: tenant role,
 *   isActive?: boolean,
 *   password?: string,
 *   orgUnitId?: string | null
 * }
 */
router.patch("/:id", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        const actor = req.user;
        if (!actor?.role || !requireAdminWriteAccess(actor)) {
            return res.status(403).json({ error: "Forbidden" });
        }
        if (!actor.tenantId) {
            return res.status(400).json({ error: "Tenant context required" });
        }
        const id = getParamId(req);
        if (!id)
            return res.status(400).json({ error: "id is required" });
        const existing = await client_1.prisma.user.findFirst({
            where: { id, tenantId: actor.tenantId },
            select: { id: true },
        });
        if (!existing) {
            return res.status(404).json({ error: "User not found" });
        }
        const { email, role, isActive, password, orgUnitId } = req.body;
        const data = {};
        if (typeof email === "string") {
            if (!email.trim())
                return res.status(400).json({ error: "email cannot be empty" });
            data.email = email.trim().toLowerCase();
        }
        if (typeof isActive === "boolean") {
            data.isActive = isActive;
        }
        if (typeof role !== "undefined") {
            if (!isTenantRole(role))
                return res.status(400).json({ error: "invalid role" });
            data.role = role;
        }
        if (typeof password === "string") {
            const pw = password.trim();
            if (pw) {
                if (pw.length < 6) {
                    return res.status(400).json({ error: "password must be at least 6 characters" });
                }
                data.passwordHash = await bcrypt_1.default.hash(pw, 10);
            }
        }
        if (typeof orgUnitId !== "undefined") {
            if (orgUnitId === null)
                data.orgUnitId = null;
            else if (typeof orgUnitId === "string")
                data.orgUnitId = orgUnitId.trim() ? orgUnitId.trim() : null;
            else
                return res.status(400).json({ error: "orgUnitId must be string or null" });
        }
        if (Object.keys(data).length === 0) {
            return res.status(400).json({ error: "No changes provided" });
        }
        const updated = await client_1.prisma.user.update({
            where: { id },
            data,
            select: {
                id: true,
                email: true,
                role: true,
                tenantId: true,
                orgUnitId: true,
                isActive: true,
                lastLoginAt: true,
                createdAt: true,
            },
        });
        return res.json({ ok: true, user: updated });
    }
    catch (err) {
        if (err?.code === "P2002") {
            return res.status(409).json({ error: "Email already exists" });
        }
        console.error(err);
        return res.status(500).json({ error: "Failed to update user" });
    }
});
/**
 * DELETE /admin/users/:id
 *
 * Biztonságos tenant-szintű törlés: soft delete (isActive=false).
 */
router.delete("/:id", authJwt_1.authJwt, tenant_1.requireTenant, async (req, res) => {
    try {
        const actor = req.user;
        if (!actor?.role || !requireAdminWriteAccess(actor)) {
            return res.status(403).json({ error: "Forbidden" });
        }
        if (!actor.tenantId) {
            return res.status(400).json({ error: "Tenant context required" });
        }
        const id = getParamId(req);
        if (!id)
            return res.status(400).json({ error: "id is required" });
        const existing = await client_1.prisma.user.findFirst({
            where: { id, tenantId: actor.tenantId },
            select: { id: true },
        });
        if (!existing) {
            return res.status(404).json({ error: "User not found" });
        }
        await client_1.prisma.user.update({
            where: { id },
            data: { isActive: false },
        });
        return res.json({ ok: true });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to delete user" });
    }
});
exports.default = router;
