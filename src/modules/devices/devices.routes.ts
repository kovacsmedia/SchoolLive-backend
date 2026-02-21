import { Router } from "express";
import { authJwt } from "../../middleware/authJwt";
import { requireTenant } from "../../middleware/tenant";
import { listDevices } from "./devices.controller";
import { registerDevice } from "./devices.controller";
import { deviceBeacon } from "./devices.controller";
import { deviceAuth } from "../../middleware/deviceAuth";

export const devicesRouter = Router();

// később RBAC-ot teszünk rá, most csak auth + tenant
devicesRouter.get("/", authJwt, requireTenant, listDevices);
devicesRouter.post("/register", authJwt, requireTenant, registerDevice);
devicesRouter.post("/beacon", deviceAuth, deviceBeacon);
