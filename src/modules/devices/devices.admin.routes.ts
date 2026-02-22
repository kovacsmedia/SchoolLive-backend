import { Router } from "express"
import { prisma } from "../../prisma/client"
import { authJwt } from "../../middleware/authJwt"

const router = Router()

router.get("/health", authJwt, async (req, res) => {
  try {
    const user = (req as any).user

    const whereTenant =
      user.role === "SUPER_ADMIN"
        ? {}
        : { tenantId: user.tenantId }

    const devices = await prisma.device.findMany({
      where: whereTenant,
      select: {
        id: true,
        name: true,
        lastSeenAt: true
      }
    })

    const now = Date.now()

    const result = devices.map(d => {
      const secondsSinceLastSeen = d.lastSeenAt
        ? Math.floor((now - new Date(d.lastSeenAt).getTime()) / 1000)
        : null

      const status =
        secondsSinceLastSeen !== null && secondsSinceLastSeen < 30
          ? "ONLINE"
          : "OFFLINE"

      return {
        id: d.id,
        name: d.name,
        status,
        secondsSinceLastSeen
      }
    })

    res.json(result)

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: "Failed to fetch device health" })
  }
})

export default router