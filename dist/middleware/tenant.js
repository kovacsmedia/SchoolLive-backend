"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireTenant = requireTenant;
function isUuidLike(value) {
    // UUID v4-ish basic check (good enough for request validation)
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}
function requireTenant(req, res, next) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    // SUPER_ADMIN: tenant context must come from header
    if (req.user.role === "SUPER_ADMIN") {
        const tenantId = req.get("x-tenant-id")?.trim();
        if (!tenantId) {
            return res.status(400).json({
                error: "Tenant context required",
                hint: "SUPER_ADMIN requests must include header: x-tenant-id",
            });
        }
        if (!isUuidLike(tenantId)) {
            return res.status(400).json({
                error: "Invalid tenant id",
                hint: "x-tenant-id must be a UUID",
            });
        }
        // Attach tenant context for downstream controllers/services
        req.tenantId = tenantId;
        // Also attach to req.user so existing code that checks user.tenantId keeps working
        req.user.tenantId = tenantId;
        return next();
    }
    // Non-superadmin: tenant comes from the token/user
    if (!req.user.tenantId) {
        return res.status(403).json({ error: "Tenant context required" });
    }
    req.tenantId = req.user.tenantId;
    next();
}
