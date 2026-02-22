import { Router } from "express"
import { prisma } from "../../prisma/client"
import bcrypt from "bcrypt"
import crypto from "crypto"
import { authJwt } from "../../middleware/authJwt"

const router = Router()

// Ideiglenes in-memory provisioning store
// Később lehet DB-ben TTL-lel
const provisioningSessions = new Map<string, {
  deviceId: string
  wifiSsid: string
  wifiPassword: string
  name: string
  expiresAt: number
}>()

router.post("/provision/start", authJwt, async (req, res) => {
  try {
    const user = (req as any).user

    if (user.role !== "TENANT_ADMIN" && user.role !== "SUPER_ADMIN") {
      return res.status(403).json({ error: "Forbidden" })
    }

    const { serialNumber, installCode, name, wifiSsid, wifiPassword } = req.body ?? {}

    if (!serialNumber || !installCode || !name || !wifiSsid || !wifiPassword) {
      return res.status(400).json({ error: "Missing required fields" })
    }

    const device = await prisma.device.findFirst({
      where: { serialNumber }
    })

    if (!device || !device.installCodeHash) {
      return res.status(404).json({ error: "Device not found or not factory-ready" })
    }

    const ok = await bcrypt.compare(installCode, device.installCodeHash)
    if (!ok) {
      return res.status(401).json({ error: "Invalid install code" })
    }

    const provisioningToken = crypto.randomBytes(32).toString("hex")

    provisioningSessions.set(provisioningToken, {
      deviceId: device.id,
      wifiSsid,
      wifiPassword,
      name,
      expiresAt: Date.now() + 2 * 60 * 1000 // 2 perc TTL
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
router.post("/provision/confirm", async (req, res) => {
  try {
    const { provisioningToken } = req.body ?? {}
    if (!provisioningToken || typeof provisioningToken !== "string") {
      return res.status(400).json({ error: "provisioningToken is required" })
    }

    const sess = provisioningSessions.get(provisioningToken)
    if (!sess) {
      return res.status(404).json({ error: "Provisioning session not found" })
    }

    if (Date.now() > sess.expiresAt) {
      provisioningSessions.delete(provisioningToken)
      return res.status(410).json({ error: "Provisioning session expired" })
    }

    // végleges deviceKey (plaintext csak most!)
    const deviceKey = crypto.randomBytes(24).toString("hex")
    const deviceKeyHash = await bcrypt.hash(deviceKey, 10)

    const device = await prisma.device.update({
      where: { id: sess.deviceId },
      data: {
        name: sess.name,
        deviceKeyHash
      },
      select: {
        id: true,
        tenantId: true,
        name: true
      }
    })

    provisioningSessions.delete(provisioningToken)

    return res.json({
      ok: true,
      device,
      deviceKey,
      wifi: {
        ssid: sess.wifiSsid,
        password: sess.wifiPassword
      }
    })

  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: "Provision confirm failed" })
  }
})
export default router