"use strict";
// src/modules/tenants/tenants.admin.routes.ts
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("../../prisma/client");
const authJwt_1 = require("../../middleware/authJwt");
const router = (0, express_1.Router)();
function requireSuperAdmin(user, res) {
    if (user?.role !== "SUPER_ADMIN") {
        res.status(403).json({ error: "Forbidden: SUPER_ADMIN only" });
        return false;
    }
    return true;
}
const SELECT = {
    id: true,
    name: true,
    domain: true,
    isActive: true,
    createdAt: true,
    address: true,
    directorName: true,
    directorPhone: true,
    directorEmail: true,
    eduId: true,
};
/**
 * GET /admin/tenants
 */
router.get("/", authJwt_1.authJwt, async (req, res) => {
    try {
        const user = req.user;
        if (!requireSuperAdmin(user, res))
            return;
        const tenants = await client_1.prisma.tenant.findMany({
            select: SELECT,
            orderBy: { name: "asc" },
        });
        return res.json({ ok: true, tenants });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to fetch tenants" });
    }
});
/**
 * POST /admin/tenants
 */
router.post("/", authJwt_1.authJwt, async (req, res) => {
    try {
        const user = req.user;
        if (!requireSuperAdmin(user, res))
            return;
        const { name, domain, isActive, address, directorName, directorPhone, directorEmail, eduId } = req.body;
        if (typeof name !== "string" || !name.trim()) {
            return res.status(400).json({ error: "name is required" });
        }
        const created = await client_1.prisma.tenant.create({
            data: {
                name: name.trim(),
                domain: typeof domain === "string" && domain.trim() ? domain.trim() : null,
                isActive: typeof isActive === "boolean" ? isActive : true,
                address: typeof address === "string" && address.trim() ? address.trim() : null,
                directorName: typeof directorName === "string" && directorName.trim() ? directorName.trim() : null,
                directorPhone: typeof directorPhone === "string" && directorPhone.trim() ? directorPhone.trim() : null,
                directorEmail: typeof directorEmail === "string" && directorEmail.trim() ? directorEmail.trim() : null,
                eduId: typeof eduId === "string" && eduId.trim() ? eduId.trim() : null,
            },
            select: SELECT,
        });
        return res.status(201).json({ ok: true, tenant: created });
    }
    catch (err) {
        if (err?.code === "P2002") {
            return res.status(409).json({ error: "Domain already exists" });
        }
        console.error(err);
        return res.status(500).json({ error: "Failed to create tenant" });
    }
});
/**
 * PATCH /admin/tenants/:id
 */
router.patch("/:id", authJwt_1.authJwt, async (req, res) => {
    try {
        const user = req.user;
        if (!requireSuperAdmin(user, res))
            return;
        const id = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id)?.trim();
        if (!id)
            return res.status(400).json({ error: "id is required" });
        const existing = await client_1.prisma.tenant.findUnique({ where: { id }, select: { id: true } });
        if (!existing)
            return res.status(404).json({ error: "Tenant not found" });
        const { name, domain, isActive, address, directorName, directorPhone, directorEmail, eduId } = req.body;
        const data = {};
        if (typeof name === "string") {
            if (!name.trim())
                return res.status(400).json({ error: "name cannot be empty" });
            data.name = name.trim();
        }
        if (typeof domain !== "undefined") {
            data.domain = typeof domain === "string" && domain.trim() ? domain.trim() : null;
        }
        if (typeof isActive === "boolean")
            data.isActive = isActive;
        if (typeof address !== "undefined") {
            data.address = typeof address === "string" && address.trim() ? address.trim() : null;
        }
        if (typeof directorName !== "undefined") {
            data.directorName = typeof directorName === "string" && directorName.trim() ? directorName.trim() : null;
        }
        if (typeof directorPhone !== "undefined") {
            data.directorPhone = typeof directorPhone === "string" && directorPhone.trim() ? directorPhone.trim() : null;
        }
        if (typeof directorEmail !== "undefined") {
            data.directorEmail = typeof directorEmail === "string" && directorEmail.trim() ? directorEmail.trim() : null;
        }
        if (typeof eduId !== "undefined") {
            data.eduId = typeof eduId === "string" && eduId.trim() ? eduId.trim() : null;
        }
        if (Object.keys(data).length === 0) {
            return res.status(400).json({ error: "No changes provided" });
        }
        const updated = await client_1.prisma.tenant.update({
            where: { id },
            data,
            select: SELECT,
        });
        return res.json({ ok: true, tenant: updated });
    }
    catch (err) {
        if (err?.code === "P2002") {
            return res.status(409).json({ error: "Domain already exists" });
        }
        console.error(err);
        return res.status(500).json({ error: "Failed to update tenant" });
    }
});
/**
 * DELETE /admin/tenants/:id
 *
 * ?permanent=true → hard delete cascade sorrendben:
 *   DeviceCommand → Message → RadioSchedule → RadioFile →
 *   DeviceCommand (device-hoz) → Device → PendingDevice →
 *   BellCalendarDay → BellScheduleEntry → BellScheduleTemplate →
 *   User → Tenant
 *
 * alapértelmezett → soft delete (isActive=false)
 */
router.delete("/:id", authJwt_1.authJwt, async (req, res) => {
    try {
        const user = req.user;
        if (!requireSuperAdmin(user, res))
            return;
        const id = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id)?.trim();
        if (!id)
            return res.status(400).json({ error: "id is required" });
        const existing = await client_1.prisma.tenant.findUnique({
            where: { id },
            select: { id: true, name: true },
        });
        if (!existing)
            return res.status(404).json({ error: "Tenant not found" });
        const permanent = req.query.permanent === "true";
        if (!permanent) {
            // Soft delete
            await client_1.prisma.tenant.update({ where: { id }, data: { isActive: false } });
            // Userek session-jeit is töröljük
            await client_1.prisma.$executeRaw `
        UPDATE "User" SET "activeSessionId" = NULL WHERE "tenantId" = ${id}
      `.catch(() => { });
            return res.json({ ok: true, deleted: false, deactivated: true });
        }
        // ── Hard delete – teljes cascade tranzakcióban ──────────────────────────
        console.log(`[DELETE TENANT] Starting cascade delete for tenant ${id} (${existing.name})`);
        // ── Helper: biztonságos törlés – szinkron TypeError-t is elnyeli ──────────
        async function safeDelete(fn) {
            try {
                await fn();
            }
            catch { /* modell nem létezik vagy nincs adat – OK */ }
        }
        await client_1.prisma.$transaction(async (tx) => {
            // 1. DeviceCommand-ok törlése (Message-ekhez kapcsolva)
            await safeDelete(() => tx.deviceCommand.deleteMany({
                where: { message: { tenantId: id } },
            }));
            // 2. Üzenetek törlése
            await safeDelete(() => tx.message.deleteMany({ where: { tenantId: id } }));
            // 3. RadioSchedule törlése
            await safeDelete(() => tx.radioSchedule.deleteMany({ where: { tenantId: id } }));
            // 4. RadioFile törlése
            await safeDelete(() => tx.radioFile.deleteMany({ where: { tenantId: id } }));
            // 5. DeviceCommand-ok törlése (Device-ekhez kapcsolva)
            let deviceIds = [];
            try {
                const devices = await tx.device.findMany({
                    where: { tenantId: id },
                    select: { id: true },
                });
                deviceIds = devices.map((d) => d.id);
            }
            catch { }
            if (deviceIds.length > 0) {
                await safeDelete(() => tx.deviceCommand.deleteMany({
                    where: { deviceId: { in: deviceIds } },
                }));
            }
            // 6. Device-ok törlése
            await safeDelete(() => tx.device.deleteMany({ where: { tenantId: id } }));
            // 7. PendingDevice törlése
            await safeDelete(() => tx.pendingDevice.deleteMany({ where: { tenantId: id } }));
            // 8. BellCalendarDay törlése
            await safeDelete(() => tx.bellCalendarDay.deleteMany({ where: { tenantId: id } }));
            // 9. BellScheduleEntry törlése (template-ekhez kapcsolva)
            let templateIds = [];
            try {
                const templates = await tx.bellScheduleTemplate.findMany({
                    where: { tenantId: id },
                    select: { id: true },
                });
                templateIds = templates.map((t) => t.id);
            }
            catch { }
            if (templateIds.length > 0) {
                await safeDelete(() => tx.bellScheduleEntry.deleteMany({
                    where: { templateId: { in: templateIds } },
                }));
            }
            // 10. BellScheduleTemplate törlése
            await safeDelete(() => tx.bellScheduleTemplate.deleteMany({ where: { tenantId: id } }));
            // 11. Userek törlése
            await tx.user.deleteMany({ where: { tenantId: id } });
            // 12. Maga a Tenant
            await tx.tenant.delete({ where: { id } });
        }, {
            timeout: 30_000,
        });
        console.log(`[DELETE TENANT] Cascade delete complete for tenant ${id}`);
        return res.json({ ok: true, deleted: true });
    }
    catch (err) {
        console.error("[DELETE TENANT]", err);
        if (err?.code === "P2003" || err?.code === "P2014") {
            return res.status(409).json({
                error: "Kapcsolódó adatok miatt nem törölhető. Próbáld újra, vagy keresd fel a fejlesztőt.",
            });
        }
        return res.status(500).json({ error: "Failed to delete tenant" });
    }
});
exports.default = router;
