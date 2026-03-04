// src/modules/devices/devices.provision.routes.ts

import { Router } from "express";
import { prisma } from "../../prisma/client";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { authJwt } from "../../middleware/authJwt";

const router = Router();

/**
 * POST /provision/register
 * ESP32 hívja be magát provisioning módban.
 * Nem kell auth – a MAC cím azonosít.
 * Body: { mac, firmwareVersion?, ipAddress? }
 */
router.post("/register", async (req, res) => {
  try {
    const { mac, firmwareVersion, ipAddress } = req.body ?? {};

    if (!mac || typeof mac !== "string" || !mac.trim()) {
      return res.status(400).json({ error: "mac is required" });
    }

    const normalizedMac = mac.trim().toUpperCase();

    const pending = await prisma.pendingDevice.upsert({
      where: { mac: normalizedMac },
      update: {
        ipAddress: typeof ipAddress === "string" ? ipAddress.trim() : null,
        firmwareVersion: typeof firmwareVersion === "string" ? firmwareVersion.trim() : null,
        lastSeenAt: new Date(),
      },
      create: {
        mac: normalizedMac,
        ipAddress: typeof ipAddress === "string" ? ipAddress.trim() : null,
        firmwareVersion: typeof firmwareVersion === "string" ? firmwareVersion.trim() : null,
      },
    });

    return res.json({ ok: true, pendingId: pending.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Register failed" });
  }
});

/**
 * GET /provision/status/:pendingId
 * ESP32 polloz – megtudjuk hogy aktiválták-e már.
 * Ha igen: megkapja a deviceKey-t és a wifi adatokat.
 */
router.get("/status/:pendingId", async (req, res) => {
  try {
    const { pendingId } = req.params;

    // Megnézzük hogy van-e már aktivált device ehhez a pendingId-hoz
    // Az aktiváláskor a PendingDevice-t töröljük és a Device-on eltároljuk a pendingId-t átmenetileg
    const pending = await prisma.pendingDevice.findUnique({
      where: { id: pendingId },
    });

    if (pending) {
      // Még nem aktiválták
      await prisma.pendingDevice.update({
        where: { id: pendingId },
        data: { lastSeenAt: new Date() },
      });
      return res.json({ ok: true, status: "pending" });
    }

    // Törölt → keressük az aktivált device-t
    const device = await prisma.device.findFirst({
      where: { clientId: pendingId },
      select: {
        id: true,
        name: true,
        deviceKeyHash: true,
        clientId: true,
      },
    });

    if (!device) {
      return res.status(404).json({ error: "Not found" });
    }

    // A deviceKey plaintext-et a provisionSession-ben tároljuk átmenetileg
    const session = await prisma.deviceProvisionSession.findFirst({
      where: { deviceId: device.id },
      orderBy: { createdAt: "desc" },
    });

    if (!session) {
      return res.json({ ok: true, status: "activated", config: null });
    }

    return res.json({
      ok: true,
      status: "activated",
      config: {
        deviceId: device.id,
        deviceName: device.name,
        wifiSsid: session.wifiSsid,
        wifiPassword: session.wifiPassword,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Status check failed" });
  }
});

/**
 * GET /provision/pending
 * Admin listázza az aktiválásra váró eszközöket.
 * Csak SUPER_ADMIN láthatja (tenant-független).
 */
router.get("/pending", authJwt, async (req, res) => {
  try {
    const user = (req as any).user;

    if (user?.role !== "SUPER_ADMIN" && user?.role !== "TENANT_ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    // 2 percnél régebben nem látott eszközöket nem mutatjuk
    const cutoff = new Date(Date.now() - 2 * 60 * 1000);

    const pending = await prisma.pendingDevice.findMany({
      where: { lastSeenAt: { gte: cutoff } },
      orderBy: { lastSeenAt: "desc" },
    });

    return res.json({ ok: true, pending });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch pending devices" });
  }
});

/**
 * POST /provision/activate
 * Admin aktiválja a kiválasztott eszközt.
 * Body: { pendingId, tenantId, name, deviceClass, wifiSsid, wifiPassword, orgUnitId? }
 */
router.post("/activate", authJwt, async (req, res) => {
  try {
    const user = (req as any).user;

    if (user?.role !== "SUPER_ADMIN" && user?.role !== "TENANT_ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { pendingId, tenantId, name, deviceClass, wifiSsid, wifiPassword, orgUnitId } =
      req.body ?? {};

    if (!pendingId || !tenantId || !name || !deviceClass || !wifiSsid || !wifiPassword) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const pending = await prisma.pendingDevice.findUnique({
      where: { id: pendingId },
    });

    if (!pending) {
      return res.status(404).json({ error: "Pending device not found or already activated" });
    }

    const validClasses = ["SPEAKER", "DISPLAY", "MULTI"];
    if (!validClasses.includes(deviceClass)) {
      return res.status(400).json({ error: "Invalid deviceClass" });
    }

    // Új deviceKey generálás
    const deviceKey = crypto.randomBytes(24).toString("hex");
    const deviceKeyHash = await bcrypt.hash(deviceKey, 10);

    // Device létrehozása
    const device = await prisma.device.create({
      data: {
        tenantId,
        name,
        deviceClass: deviceClass as any,
        authType: "KEY",
        deviceKeyHash,
        firmwareVersion: pending.firmwareVersion,
        ipAddress: pending.ipAddress,
        clientId: pendingId, // átmenetileg eltároljuk a pendingId-t
        ...(orgUnitId ? { orgUnitId } : {}),
      },
      select: { id: true, name: true, tenantId: true },
    });

    // ProvisionSession létrehozása (ESP32 innen kapja a wifi adatokat)
    const provisioningToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = await bcrypt.hash(provisioningToken, 10);

    await prisma.deviceProvisionSession.create({
      data: {
        tokenHash,
        deviceId: device.id,
        tenantId,
        name,
        wifiSsid,
        wifiPassword,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 perc
      },
    });

    // PendingDevice törlése – az ESP32 status poll-nál látja hogy aktivált
    await prisma.pendingDevice.delete({ where: { id: pendingId } });

    return res.json({ ok: true, device, deviceKey });
  } catch (err: any) {
    if (err?.code === "P2002") {
      return res.status(409).json({ error: "Device name already exists in this tenant" });
    }
    console.error(err);
    return res.status(500).json({ error: "Activation failed" });
  }
});

/**
 * POST /provision/provision/start  (régi flow – megtartjuk kompatibilitásból)
 */
router.post("/provision/start", authJwt, async (req, res) => {
  try {
    const user = (req as any).user;

    if (user.role !== "TENANT_ADMIN" && user.role !== "SUPER_ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { serialNumber, installCode, name, wifiSsid, wifiPassword } = req.body ?? {};

    if (!serialNumber || !installCode || !name || !wifiSsid || !wifiPassword) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const device = await prisma.device.findFirst({ where: { serialNumber } });

    if (!device || !device.installCodeHash) {
      return res.status(404).json({ error: "Device not found or not factory-ready" });
    }

    const installOk = await bcrypt.compare(installCode, device.installCodeHash);
    if (!installOk) {
      return res.status(401).json({ error: "Invalid install code" });
    }

    const provisioningToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = await bcrypt.hash(provisioningToken, 10);

    await prisma.deviceProvisionSession.create({
      data: {
        tokenHash,
        deviceId: device.id,
        tenantId: user.tenantId ?? null,
        name,
        wifiSsid,
        wifiPassword,
        expiresAt: new Date(Date.now() + 2 * 60 * 1000),
      },
    });

    return res.json({ provisioningToken, expiresInSeconds: 120 });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Provision start failed" });
  }
});

/**
 * POST /provision/provision/confirm (régi flow)
 */
router.post("/provision/confirm", async (req, res) => {
  try {
    const { provisioningToken } = req.body ?? {};
    if (!provisioningToken) {
      return res.status(400).json({ error: "provisioningToken is required" });
    }

    const sessions = await prisma.deviceProvisionSession.findMany({
      where: { expiresAt: { gt: new Date() } },
    });

    let matchedSession: (typeof sessions)[number] | null = null;
    for (const s of sessions) {
      const ok = await bcrypt.compare(provisioningToken, s.tokenHash);
      if (ok) { matchedSession = s; break; }
    }

    if (!matchedSession) {
      return res.status(404).json({ error: "Provisioning session not found or expired" });
    }

    const deviceKey = crypto.randomBytes(24).toString("hex");
    const deviceKeyHash = await bcrypt.hash(deviceKey, 10);

    const device = await prisma.device.update({
      where: { id: matchedSession.deviceId },
      data: { name: matchedSession.name, deviceKeyHash },
      select: { id: true, tenantId: true, name: true },
    });

    await prisma.deviceProvisionSession.delete({ where: { id: matchedSession.id } });

    return res.json({
      ok: true, device, deviceKey,
      wifi: { ssid: matchedSession.wifiSsid, password: matchedSession.wifiPassword },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Provision confirm failed" });
  }
});

export default router;