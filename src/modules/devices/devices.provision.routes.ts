import { Router } from "express"
import { prisma } from "../../prisma/client"
import bcrypt from "bcrypt"
import crypto from "crypto"
import { authJwt } from "../../middleware/authJwt"

const router = Router()

// POST /provision/provision/start  (mivel app.ts-ben /provision alá van mountolva)
router.post("/provision/start", authJwt, async (req, res) => {
  try {
    const user = (req as any).user

    if (user.role !== "TENANT_ADMIN" && user.role !== "SUPER_ADMIN") {
      return res.status(403).json({ error: "Forbidden" })
    }

    const { serialNumber, installCode, name, wifiSsid, wifiPassword } = req.body ?? {}

    if (
      !serialNumber || typeof serialNumber !== "string" ||
      !installCode || typeof installCode !== "string" ||
      !name || typeof name !== "string" ||
      !wifiSsid || typeof wifiSsid !== "string" ||
      !wifiPassword || typeof wifiPassword !== "string"
    ) {
      return res.status(400).json({ error: "Missing required fields" })
    }

    const device = await prisma.device.findFirst({
      where: { serialNumber }
    })

    if (!device || !device.installCodeHash) {
      return res.status(404).json({ error: "Device not found or not factory-ready" })
    }

    const installOk = await bcrypt.compare(installCode, device.installCodeHash)
    if (!installOk) {
      return res.status(401).json({ error: "Invalid install code" })
    }

    // Új provisioning token (plaintext csak a válaszban)
    const provisioningToken = crypto.randomBytes(32).toString("hex")
    const tokenHash = await bcrypt.hash(provisioningToken, 10)

    await prisma.deviceProvisionSession.create({
      data: {
        tokenHash,
        deviceId: device.id,
        tenantId: user.tenantId ?? null,
        name,
        wifiSsid,
        wifiPassword,
        expiresAt: new Date(Date.now() + 2 * 60 * 1000) // 2 perc
      }
    })

    return res.json({
      provisioningToken,
      expiresInSeconds: 120
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: "Provision start failed" })
  }
})

// POST /provision/provision/confirm
router.post("/provision/confirm", async (req, res) => {
  try {
    const { provisioningToken } = req.body ?? {}
    if (!provisioningToken || typeof provisioningToken !== "string") {
      return res.status(400).json({ error: "provisioningToken is required" })
    }

    // Megkeressük az összes még érvényes sessiont (bcrypt miatt nem tudunk tokenHash-re direkt where-t)
    const sessions = await prisma.deviceProvisionSession.findMany({
      where: {
        expiresAt: { gt: new Date() }
      }
    })

    let matchedSession: (typeof sessions)[number] | null = null

    for (const s of sessions) {
      const ok = await bcrypt.compare(provisioningToken, s.tokenHash)
      if (ok) {
        matchedSession = s
        break
      }
    }

    if (!matchedSession) {
      return res.status(404).json({ error: "Provisioning session not found or expired" })
    }

    // Végleges deviceKey (plaintext csak most!)
    const deviceKey = crypto.randomBytes(24).toString("hex")
    const deviceKeyHash = await bcrypt.hash(deviceKey, 10)

    const device = await prisma.device.update({
      where: { id: matchedSession.deviceId },
      data: {
        name: matchedSession.name,
        deviceKeyHash
      },
      select: {
        id: true,
        tenantId: true,
        name: true
      }
    })

    // egyszer használatos session → töröljük
    await prisma.deviceProvisionSession.delete({
      where: { id: matchedSession.id }
    })

    return res.json({
      ok: true,
      device,
      deviceKey,
      wifi: {
        ssid: matchedSession.wifiSsid,
        password: matchedSession.wifiPassword
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: "Provision confirm failed" })
  }
})

export default router