"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bellsRouter = void 0;
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const crypto_1 = __importDefault(require("crypto"));
const axios_1 = __importDefault(require("axios"));
const prisma_1 = __importDefault(require("../../prisma"));
const authJwt_1 = require("../../middleware/authJwt");
exports.bellsRouter = (0, express_1.Router)();
/** UTC-éjféli Date objektum az aktuális helyi (Europe/Budapest) naptári napra */
function todayInBudapest() {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Budapest",
        year: "numeric", month: "2-digit", day: "2-digit"
    });
    const [year, month, day] = fmt.format(now).split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
}
const AUDIO_DIR = path_1.default.join(process.cwd(), "audio", "bells");
const MAX_TOTAL_BYTES = 500 * 1024;
const DEFAULT_SOUNDS = ["jelzocsengo.mp3", "kibecsengo.mp3"];
if (!fs_1.default.existsSync(AUDIO_DIR))
    fs_1.default.mkdirSync(AUDIO_DIR, { recursive: true });
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => cb(null, AUDIO_DIR),
    filename: (_req, file, cb) => cb(null, file.originalname),
});
const upload = (0, multer_1.default)({
    storage,
    fileFilter: (_req, file, cb) => {
        if (file.mimetype === "audio/mpeg" || file.originalname.endsWith(".mp3")) {
            cb(null, true);
        }
        else {
            cb(new Error("Only MP3 files allowed"));
        }
    },
});
function tid(req) {
    const fromHeader = req.headers["x-tenant-id"];
    if (fromHeader)
        return fromHeader;
    return req.user?.tenantId;
}
function uid(req) { return req.user?.sub; }
function userRole(req) { return req.user?.role; }
const ORG_ADMIN_ROLES = ["ORG_ADMIN", "TENANT_ADMIN", "SUPER_ADMIN"];
function canEdit(req, res, next) {
    if (!ORG_ADMIN_ROLES.includes(userRole(req))) {
        return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
}
function makeVersion(scope, bells) {
    const raw = `${scope}:${bells.map(b => `${b.hour}:${b.minute}:${b.type}:${b.soundFile}`).join(",")}`;
    return crypto_1.default.createHash("md5").update(raw).digest("hex").slice(0, 12);
}
async function authenticateDevice(req) {
    const deviceKey = req.headers["x-device-key"];
    if (!deviceKey)
        return null;
    const bcrypt = await Promise.resolve().then(() => __importStar(require("bcrypt")));
    const devices = await prisma_1.default.device.findMany({ where: { authType: "KEY" } });
    for (const d of devices) {
        if (d.deviceKeyHash && await bcrypt.compare(deviceKey, d.deviceKeyHash)) {
            return d;
        }
    }
    return null;
}
async function resolveTodayBells(tenantId, today) {
    const dateStr = today.toISOString().split("T")[0];
    const calDay = await prisma_1.default.bellCalendarDay.findUnique({
        where: { tenantId_date: { tenantId, date: today } },
        include: { template: { include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } } } },
    });
    const defaultTemplate = await prisma_1.default.bellScheduleTemplate.findFirst({
        where: { tenantId, isDefault: true },
        include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } },
    });
    const defaultBells = defaultTemplate?.bells ?? [];
    const defaultVersion = makeVersion("default", defaultBells);
    let bells = [];
    let isHoliday = false;
    if (calDay?.isHoliday) {
        isHoliday = true;
    }
    else if (calDay?.template) {
        bells = calDay.template.bells;
    }
    else {
        bells = defaultBells;
    }
    const todayVersion = isHoliday
        ? `holiday:${dateStr}`
        : makeVersion(dateStr, bells);
    return { bells, defaultBells, isHoliday, todayVersion, defaultVersion };
}
// ─── SYNC_BELLS dispatch helper ────────────────────────────────────────────
// Minden VP eszközre (authType: JWT) küld egy SYNC_BELLS parancsot,
// hogy azonnal szinkronizálják a csengetési rendet.
async function dispatchSyncBellsToVP(tenantId) {
    try {
        const vpDevices = await prisma_1.default.device.findMany({
            where: { tenantId, authType: "JWT" },
            select: { id: true },
        });
        if (vpDevices.length === 0)
            return;
        await prisma_1.default.deviceCommand.createMany({
            data: vpDevices.map(d => ({
                tenantId,
                deviceId: d.id,
                status: "QUEUED",
                payload: { action: "SYNC_BELLS" },
            })),
        });
        console.log(`[BELLS] SYNC_BELLS dispatched to ${vpDevices.length} VP device(s) in tenant ${tenantId}`);
    }
    catch (e) {
        console.error("[BELLS] dispatchSyncBellsToVP error:", e);
    }
}
// ─── Sablonok ──────────────────────────────────────────────────────────────
exports.bellsRouter.get("/templates", authJwt_1.authJwt, canEdit, async (req, res) => {
    const templates = await prisma_1.default.bellScheduleTemplate.findMany({
        where: { tenantId: tid(req) },
        include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } },
        orderBy: { createdAt: "asc" },
    });
    res.json({ ok: true, templates });
});
exports.bellsRouter.post("/templates", authJwt_1.authJwt, canEdit, async (req, res) => {
    const { name, bells } = req.body;
    if (!name || !Array.isArray(bells)) {
        return res.status(400).json({ error: "name and bells required" });
    }
    const count = await prisma_1.default.bellScheduleTemplate.count({ where: { tenantId: tid(req) } });
    if (count >= 6)
        return res.status(400).json({ error: "Maximum 6 templates allowed" });
    const template = await prisma_1.default.bellScheduleTemplate.create({
        data: {
            tenantId: tid(req),
            name,
            isDefault: false,
            isLocked: false,
            bells: {
                create: bells.map((b) => ({
                    hour: b.hour,
                    minute: b.minute,
                    type: b.type,
                    soundFile: b.soundFile || (b.type === "SIGNAL" ? "jelzocsengo.mp3" : "kibecsengo.mp3"),
                })),
            },
        },
        include: { bells: true },
    });
    // VP eszközök értesítése
    void dispatchSyncBellsToVP(tid(req));
    res.status(201).json({ ok: true, template });
});
exports.bellsRouter.put("/templates/:id", authJwt_1.authJwt, canEdit, async (req, res) => {
    const templateId = req.params.id;
    const { name, bells } = req.body;
    const template = await prisma_1.default.bellScheduleTemplate.findFirst({
        where: { id: templateId, tenantId: tid(req) },
    });
    if (!template)
        return res.status(404).json({ error: "Not found" });
    if (template.isLocked)
        return res.status(403).json({ error: "Cannot modify locked template" });
    await prisma_1.default.bellEntry.deleteMany({ where: { templateId: template.id } });
    const updated = await prisma_1.default.bellScheduleTemplate.update({
        where: { id: template.id },
        data: {
            name,
            bells: {
                create: bells.map((b) => ({
                    hour: b.hour,
                    minute: b.minute,
                    type: b.type,
                    soundFile: b.soundFile || (b.type === "SIGNAL" ? "jelzocsengo.mp3" : "kibecsengo.mp3"),
                })),
            },
        },
        include: { bells: true },
    });
    // VP eszközök értesítése
    void dispatchSyncBellsToVP(tid(req));
    res.json({ ok: true, template: updated });
});
exports.bellsRouter.delete("/templates/:id", authJwt_1.authJwt, canEdit, async (req, res) => {
    const templateId = req.params.id;
    const template = await prisma_1.default.bellScheduleTemplate.findFirst({
        where: { id: templateId, tenantId: tid(req) },
    });
    if (!template)
        return res.status(404).json({ error: "Not found" });
    if (template.isLocked)
        return res.status(403).json({ error: "Cannot delete locked template" });
    await prisma_1.default.bellScheduleTemplate.delete({ where: { id: template.id } });
    // VP eszközök értesítése
    void dispatchSyncBellsToVP(tid(req));
    res.json({ ok: true });
});
exports.bellsRouter.put("/templates/:id/set-default", authJwt_1.authJwt, canEdit, async (req, res) => {
    const templateId = req.params.id;
    const template = await prisma_1.default.bellScheduleTemplate.findFirst({
        where: { id: templateId, tenantId: tid(req) },
    });
    if (!template)
        return res.status(404).json({ error: "Not found" });
    await prisma_1.default.$transaction([
        prisma_1.default.bellScheduleTemplate.updateMany({
            where: { tenantId: tid(req) },
            data: { isDefault: false },
        }),
        prisma_1.default.bellScheduleTemplate.update({
            where: { id: templateId },
            data: { isDefault: true },
        }),
    ]);
    const updated = await prisma_1.default.bellScheduleTemplate.findUnique({
        where: { id: templateId },
        include: { bells: { orderBy: [{ hour: "asc" }, { minute: "asc" }] } },
    });
    // VP eszközök értesítése
    void dispatchSyncBellsToVP(tid(req));
    res.json({ ok: true, template: updated });
});
// ─── Naptár ────────────────────────────────────────────────────────────────
exports.bellsRouter.get("/calendar", authJwt_1.authJwt, canEdit, async (req, res) => {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const from = new Date(`${year}-01-01`);
    const to = new Date(`${year}-12-31`);
    const days = await prisma_1.default.bellCalendarDay.findMany({
        where: { tenantId: tid(req), date: { gte: from, lte: to } },
        include: { template: { include: { bells: true } } },
        orderBy: { date: "asc" },
    });
    res.json({ ok: true, days });
});
exports.bellsRouter.post("/calendar/init", authJwt_1.authJwt, canEdit, async (req, res) => {
    const year = parseInt(req.body.year) || new Date().getFullYear();
    try {
        const resp = await axios_1.default.get(`https://szunetnapok.hu/api/?year=${year}&country=hu`);
        const holidays = resp.data?.holidays || [];
        const weekends = [];
        const d = new Date(`${year}-01-01`);
        while (d.getFullYear() === year) {
            if (d.getDay() === 0 || d.getDay() === 6) {
                weekends.push(d.toISOString().split("T")[0]);
            }
            d.setDate(d.getDate() + 1);
        }
        const allHolidays = [...new Set([...holidays, ...weekends])];
        for (const dateStr of allHolidays) {
            await prisma_1.default.bellCalendarDay.upsert({
                where: { tenantId_date: { tenantId: tid(req), date: new Date(dateStr) } },
                update: { isHoliday: true },
                create: { tenantId: tid(req), date: new Date(dateStr), isHoliday: true },
            });
        }
        res.json({ ok: true, imported: allHolidays.length });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch holidays" });
    }
});
exports.bellsRouter.put("/calendar/:date", authJwt_1.authJwt, canEdit, async (req, res) => {
    const { isHoliday, templateId } = req.body;
    const dateStr = req.params.date;
    const date = new Date(dateStr);
    const day = await prisma_1.default.bellCalendarDay.upsert({
        where: { tenantId_date: { tenantId: tid(req), date } },
        update: { isHoliday: isHoliday ?? false, templateId: templateId ?? null },
        create: { tenantId: tid(req), date, isHoliday: isHoliday ?? false, templateId: templateId ?? null },
        include: { template: true },
    });
    // VP eszközök értesítése
    void dispatchSyncBellsToVP(tid(req));
    res.json({ ok: true, day });
});
// ─── Hangfájlok ────────────────────────────────────────────────────────────
exports.bellsRouter.get("/sounds", authJwt_1.authJwt, canEdit, async (req, res) => {
    const sounds = await prisma_1.default.bellSoundFile.findMany({
        where: { tenantId: tid(req) },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
    res.json({ ok: true, sounds });
});
exports.bellsRouter.post("/sounds", authJwt_1.authJwt, canEdit, upload.single("file"), async (req, res) => {
    const file = req.file;
    if (!file)
        return res.status(400).json({ error: "No file uploaded" });
    const existing = await prisma_1.default.bellSoundFile.findMany({ where: { tenantId: tid(req) } });
    const totalUsed = existing.reduce((sum, s) => sum + s.sizeBytes, 0);
    const available = MAX_TOTAL_BYTES - totalUsed;
    if (file.size > available) {
        fs_1.default.unlinkSync(file.path);
        return res.status(400).json({
            error: `Not enough space. Available: ${Math.floor(available / 1024)}KB, needed: ${Math.floor(file.size / 1024)}KB`,
        });
    }
    const sound = await prisma_1.default.bellSoundFile.upsert({
        where: { tenantId_filename: { tenantId: tid(req), filename: file.originalname } },
        update: { sizeBytes: file.size },
        create: {
            tenantId: tid(req),
            filename: file.originalname,
            sizeBytes: file.size,
            isDefault: DEFAULT_SOUNDS.includes(file.originalname),
        },
    });
    // Új hangfájl feltöltésekor is szinkronizáljuk
    void dispatchSyncBellsToVP(tid(req));
    res.status(201).json({ ok: true, sound });
});
exports.bellsRouter.delete("/sounds/:id", authJwt_1.authJwt, canEdit, async (req, res) => {
    const soundId = req.params.id;
    const sound = await prisma_1.default.bellSoundFile.findFirst({
        where: { id: soundId, tenantId: tid(req) },
    });
    if (!sound)
        return res.status(404).json({ error: "Not found" });
    if (sound.isDefault)
        return res.status(403).json({ error: "Cannot delete default sound" });
    const filePath = path_1.default.join(AUDIO_DIR, sound.filename);
    if (fs_1.default.existsSync(filePath))
        fs_1.default.unlinkSync(filePath);
    await prisma_1.default.bellSoundFile.delete({ where: { id: sound.id } });
    res.json({ ok: true });
});
// ─── Szerkesztési zár ──────────────────────────────────────────────────────
exports.bellsRouter.post("/lock", authJwt_1.authJwt, canEdit, async (req, res) => {
    const existing = await prisma_1.default.bellScheduleLock.findUnique({ where: { tenantId: tid(req) } });
    if (existing && existing.userId !== uid(req)) {
        const age = Date.now() - existing.lockedAt.getTime();
        if (age < 30 * 60 * 1000) {
            return res.status(409).json({ error: "Locked by another user", lockedAt: existing.lockedAt });
        }
    }
    const lock = await prisma_1.default.bellScheduleLock.upsert({
        where: { tenantId: tid(req) },
        update: { userId: uid(req), lockedAt: new Date() },
        create: { tenantId: tid(req), userId: uid(req) },
    });
    res.json({ ok: true, lock });
});
exports.bellsRouter.delete("/lock", authJwt_1.authJwt, canEdit, async (req, res) => {
    await prisma_1.default.bellScheduleLock.deleteMany({
        where: { tenantId: tid(req), userId: uid(req) },
    });
    res.json({ ok: true });
});
// ─── Verzió lekérdezés ─────────────────────────────────────────────────────
exports.bellsRouter.get("/version", async (req, res) => {
    const device = await authenticateDevice(req);
    if (!device)
        return res.status(401).json({ error: "Invalid or missing device key" });
    const today = todayInBudapest();
    const { isHoliday, todayVersion, defaultVersion } = await resolveTodayBells(device.tenantId, today);
    res.json({ ok: true, todayVersion, defaultVersion, isHoliday });
});
// ─── Teljes szinkronizáció eszköznek ──────────────────────────────────────
// ─── /today – JWT-vel is elérhető (VirtualPlayer) ─────────────────────────
exports.bellsRouter.get("/today", authJwt_1.authJwt, async (req, res) => {
    const tenantId = tid(req);
    if (!tenantId)
        return res.status(400).json({ error: "Tenant required" });
    // UTC alapú dátum – a DB is UTC-ben tárolja
    const today = todayInBudapest();
    const { bells, isHoliday } = await resolveTodayBells(tenantId, today);
    return res.json({
        ok: true,
        isHoliday,
        bells: bells.map((b) => ({
            hour: b.hour,
            minute: b.minute,
            type: b.type,
            soundFile: b.soundFile,
        })),
    });
});
exports.bellsRouter.get("/sync", async (req, res) => {
    const device = await authenticateDevice(req);
    if (!device)
        return res.status(401).json({ error: "Invalid or missing device key" });
    const today = todayInBudapest();
    const { bells, defaultBells, isHoliday, todayVersion, defaultVersion } = await resolveTodayBells(device.tenantId, today);
    const sounds = await prisma_1.default.bellSoundFile.findMany({
        where: { tenantId: device.tenantId },
    });
    res.json({
        ok: true,
        isHoliday,
        todayVersion,
        defaultVersion,
        bells: bells.map((b) => ({
            hour: b.hour,
            minute: b.minute,
            type: b.type,
            soundFile: b.soundFile,
        })),
        defaultBells: defaultBells.map((b) => ({
            hour: b.hour,
            minute: b.minute,
            type: b.type,
            soundFile: b.soundFile,
        })),
        sounds: sounds.map((s) => ({
            filename: s.filename,
            url: `/audio/bells/${s.filename}`,
            sizeBytes: s.sizeBytes,
        })),
        updatedAt: new Date().toISOString(),
    });
});
