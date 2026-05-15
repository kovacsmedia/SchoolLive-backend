// src/modules/tenants/tenants.admin.routes.ts

import { Router } from "express";
import { prisma } from "../../prisma/client";
import { authJwt } from "../../middleware/authJwt";
import { allocateNextSnapPort, SNAP_PORT_RANGE } from "../snapcast/snap-port-allocator";
import { SnapcastService } from "../snapcast/snapcast.service";

const router = Router();

type JwtUser = {
  sub?: string;
  role?: string;
  tenantId?: string | null;
};

function requireSuperAdmin(user: JwtUser, res: any): boolean {
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
  snapPort: true,
} as const;

/**
 * GET /admin/tenants
 */
router.get("/", authJwt, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!requireSuperAdmin(user, res)) return;

    const tenants = await prisma.tenant.findMany({
      select: SELECT,
      orderBy: { name: "asc" },
    });

    return res.json({ ok: true, tenants });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch tenants" });
  }
});

/**
 * POST /admin/tenants
 */
router.post("/", authJwt, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!requireSuperAdmin(user, res)) return;

    const { name, domain, isActive, address, directorName, directorPhone, directorEmail, eduId } =
      req.body as Record<string, unknown>;

    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }

    // Snap port automatikus kiosztása az [1800..1880] tartományból.
    // P2002 (unique constraint) race esetén max 5x újrapróbálkozunk
    // egy másik port-kiosztással. Ha a tartomány teli, 507 Insufficient
    // Storage hiba megy vissza – az admin-nak ekkor érdemes felszabadítani
    // egy nem-használt tenant-et, vagy bővíteni a SNAP_PORT_MAX env-et.
    let created;
    let lastErr: any = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const snapPort = await allocateNextSnapPort();
      if (snapPort === null) {
        return res.status(507).json({
          error: `Nincs szabad snapPort a ${SNAP_PORT_RANGE.base}–${SNAP_PORT_RANGE.max} tartományban`,
        });
      }

      try {
        created = await prisma.tenant.create({
          data: {
            name: name.trim(),
            domain: typeof domain === "string" && domain.trim() ? domain.trim() : null,
            isActive: typeof isActive === "boolean" ? isActive : true,
            address: typeof address === "string" && address.trim() ? address.trim() : null,
            directorName: typeof directorName === "string" && directorName.trim() ? directorName.trim() : null,
            directorPhone: typeof directorPhone === "string" && directorPhone.trim() ? directorPhone.trim() : null,
            directorEmail: typeof directorEmail === "string" && directorEmail.trim() ? directorEmail.trim() : null,
            eduId: typeof eduId === "string" && eduId.trim() ? eduId.trim() : null,
            snapPort,
          },
          select: SELECT,
        });
        break;
      } catch (err: any) {
        // P2002 = unique constraint violation. Ha a `snapPort` target
        // ütközik (race két admin POST között), újraallokálunk; ha a
        // `domain` ütközik, 409-cel azonnal visszadobjuk.
        if (err?.code === "P2002") {
          const target = Array.isArray(err.meta?.target) ? err.meta.target : [];
          if (target.includes("snapPort")) {
            console.warn(`[POST /admin/tenants] snapPort race (attempt ${attempt + 1}), újra...`);
            lastErr = err;
            continue;
          }
          return res.status(409).json({ error: "Domain already exists" });
        }
        throw err;
      }
    }

    if (!created) {
      console.error("[POST /admin/tenants] 5 retry után sem sikerült snapPort-ot kiosztani:", lastErr);
      return res.status(500).json({ error: "Failed to allocate snapPort after retries" });
    }

    return res.status(201).json({ ok: true, tenant: created });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "Failed to create tenant" });
  }
});

/**
 * PATCH /admin/tenants/:id
 */
router.patch("/:id", authJwt, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!requireSuperAdmin(user, res)) return;

    const id = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id)?.trim();
    if (!id) return res.status(400).json({ error: "id is required" });

    const existing = await prisma.tenant.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return res.status(404).json({ error: "Tenant not found" });

    const { name, domain, isActive, address, directorName, directorPhone, directorEmail, eduId } =
      req.body as Record<string, unknown>;

    const data: Record<string, unknown> = {};

    if (typeof name === "string") {
      if (!name.trim()) return res.status(400).json({ error: "name cannot be empty" });
      data.name = name.trim();
    }
    if (typeof domain !== "undefined") {
      data.domain = typeof domain === "string" && domain.trim() ? domain.trim() : null;
    }
    if (typeof isActive === "boolean") data.isActive = isActive;
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

    const updated = await prisma.tenant.update({
      where: { id },
      data,
      select: SELECT,
    });

    return res.json({ ok: true, tenant: updated });
  } catch (err: any) {
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
router.delete("/:id", authJwt, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!requireSuperAdmin(user, res)) return;

    const id = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id)?.trim();
    if (!id) return res.status(400).json({ error: "id is required" });

    const existing = await prisma.tenant.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!existing) return res.status(404).json({ error: "Tenant not found" });

    const permanent = req.query.permanent === "true";

    if (!permanent) {
      // Soft delete
      await prisma.tenant.update({ where: { id }, data: { isActive: false } });
      // Userek session-jeit is töröljük
      await prisma.$executeRaw`
        UPDATE "User" SET "activeSessionId" = NULL WHERE "tenantId" = ${id}
      `.catch(() => {});
      return res.json({ ok: true, deleted: false, deactivated: true });
    }

    // ── Hard delete – teljes cascade tranzakcióban ──────────────────────────
    console.log(`[DELETE TENANT] Starting cascade delete for tenant ${id} (${existing.name})`);

    // Snapserver teardown ELŐSZÖR (a DB-cascade előtt), mert a snapPort-ot
    // a tenant rekordból olvassuk ki. Soft-delete-nél (isActive=false)
    // NEM csináljuk: oda még visszavonhatóan újra is aktiválható a tenant.
    // Hibatűrő: ha a pm2/file cleanup hibázik, a DB-cascade akkor is fut.
    try {
      await SnapcastService.dispose(id);
    } catch (e) {
      console.error(`[DELETE TENANT] Snap dispose hiba (folytatjuk):`, e);
    }

    // ── Helper: biztonságos törlés – szinkron TypeError-t is elnyeli ──────────
    async function safeDelete(fn: () => Promise<any>) {
      try { await fn(); } catch { /* modell nem létezik vagy nincs adat – OK */ }
    }

    await prisma.$transaction(async (tx) => {

      // 1. DeviceCommand-ok törlése (Message-ekhez kapcsolva)
      await safeDelete(() => tx.deviceCommand.deleteMany({
        where: { message: { tenantId: id } },
      }));

      // 2. Üzenetek törlése
      await safeDelete(() => tx.message.deleteMany({ where: { tenantId: id } }));

      // 3. RadioSchedule törlése
      await safeDelete(() => (tx as any).radioSchedule.deleteMany({ where: { tenantId: id } }));

      // 4. RadioFile törlése
      await safeDelete(() => (tx as any).radioFile.deleteMany({ where: { tenantId: id } }));

      // 5. DeviceCommand-ok törlése (Device-ekhez kapcsolva)
      let deviceIds: string[] = [];
      try {
        const devices = await (tx as any).device.findMany({
          where: { tenantId: id },
          select: { id: true },
        });
        deviceIds = devices.map((d: any) => d.id);
      } catch {}
      if (deviceIds.length > 0) {
        await safeDelete(() => tx.deviceCommand.deleteMany({
          where: { deviceId: { in: deviceIds } },
        }));
      }

      // 6. Device-ok törlése
      await safeDelete(() => (tx as any).device.deleteMany({ where: { tenantId: id } }));

      // 7. PendingDevice törlése
      await safeDelete(() => (tx as any).pendingDevice.deleteMany({ where: { tenantId: id } }));

      // 8. BellCalendarDay törlése
      await safeDelete(() => (tx as any).bellCalendarDay.deleteMany({ where: { tenantId: id } }));

      // 9. BellScheduleEntry törlése (template-ekhez kapcsolva)
      let templateIds: string[] = [];
      try {
        const templates = await (tx as any).bellScheduleTemplate.findMany({
          where: { tenantId: id },
          select: { id: true },
        });
        templateIds = templates.map((t: any) => t.id);
      } catch {}
      if (templateIds.length > 0) {
        await safeDelete(() => (tx as any).bellScheduleEntry.deleteMany({
          where: { templateId: { in: templateIds } },
        }));
      }

      // 10. BellScheduleTemplate törlése
      await safeDelete(() => (tx as any).bellScheduleTemplate.deleteMany({ where: { tenantId: id } }));

      // 11. Userek törlése
      await tx.user.deleteMany({ where: { tenantId: id } });

      // 12. Maga a Tenant
      await tx.tenant.delete({ where: { id } });

    }, {
      timeout: 30_000,
    });

    console.log(`[DELETE TENANT] Cascade delete complete for tenant ${id}`);
    return res.json({ ok: true, deleted: true });

  } catch (err: any) {
    console.error("[DELETE TENANT]", err);
    if (err?.code === "P2003" || err?.code === "P2014") {
      return res.status(409).json({
        error: "Kapcsolódó adatok miatt nem törölhető. Próbáld újra, vagy keresd fel a fejlesztőt.",
      });
    }
    return res.status(500).json({ error: "Failed to delete tenant" });
  }
});

// ─── Tenant-szintű internetrádió preset lista ────────────────────────────────
// Az admin a SchoolRadio oldalon elmenti a current netrádió listát default-nak,
// és új felhasználók (új böngészők) automatikusan ezt töltik be először.
// A user-szerkesztések továbbra is böngésző-lokálisan (localStorage), és csak
// ha még nincs lokális adat, esik vissza a tenant default-ra.

// GET /tenants/me/netradio-presets – az aktív tenant default listája
router.get("/me/netradio-presets", authJwt, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!user?.tenantId) return res.status(400).json({ error: "No active tenant" });
    const t = await prisma.tenant.findUnique({
      where:  { id: user.tenantId },
      select: { netRadioPresetsJson: true },
    });
    if (!t) return res.status(404).json({ error: "Tenant not found" });
    return res.json({ ok: true, presets: t.netRadioPresetsJson ?? null });
  } catch (err) {
    console.error("[GET /tenants/me/netradio-presets]", err);
    return res.status(500).json({ error: "Failed to fetch presets" });
  }
});

// PUT /tenants/me/netradio-presets – TENANT_ADMIN/SUPER_ADMIN beállítja a default listát
router.put("/me/netradio-presets", authJwt, async (req, res) => {
  try {
    const user = (req as any).user as JwtUser;
    if (!user?.tenantId) return res.status(400).json({ error: "No active tenant" });
    if (user.role !== "TENANT_ADMIN" && user.role !== "SUPER_ADMIN") {
      return res.status(403).json({ error: "Forbidden: TENANT_ADMIN or SUPER_ADMIN only" });
    }
    const { presets } = req.body ?? {};
    if (!Array.isArray(presets)) {
      return res.status(400).json({ error: "presets must be an array" });
    }
    // Light validation: minden elemnek string id+name + non-empty streams kell.
    const sanitized = presets
      .filter((r: any) =>
        r && typeof r.id === "string" && typeof r.name === "string"
        && Array.isArray(r.streams) && r.streams.length > 0)
      .map((r: any) => ({
        id:      String(r.id),
        name:    String(r.name),
        genre:   String(r.genre ?? ""),
        streams: r.streams
          .filter((s: any) => s && typeof s.label === "string")
          .map((s: any) => ({
            label: String(s.label),
            url:   String(s.url ?? ""),
          })),
      }))
      .filter((r: any) => r.streams.length > 0);

    if (sanitized.length === 0) {
      return res.status(400).json({ error: "Empty/invalid presets array" });
    }

    await prisma.tenant.update({
      where: { id: user.tenantId },
      data:  { netRadioPresetsJson: sanitized },
    });
    return res.json({ ok: true, count: sanitized.length });
  } catch (err) {
    console.error("[PUT /tenants/me/netradio-presets]", err);
    return res.status(500).json({ error: "Failed to save presets" });
  }
});

export default router;