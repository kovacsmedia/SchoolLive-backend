import { Router } from "express";
import { authJwt } from "../../middleware/authJwt";
import { requireTenant } from "../../middleware/tenant";
import { listDevices } from "./devices.controller";
import { registerDevice } from "./devices.controller";
import { deviceBeacon } from "./devices.controller";
import { deviceAuth } from "../../middleware/deviceAuth";
import { createDeviceCommand } from "./devices.controller";
import { pollCommands } from "./devices.controller";
import { ackCommand } from "./devices.controller";

export const devicesRouter = Router();

// később RBAC-ot teszünk rá, most csak auth + tenant
devicesRouter.get("/", authJwt, requireTenant, listDevices);
devicesRouter.post("/register", authJwt, requireTenant, registerDevice);
devicesRouter.post("/beacon", deviceAuth, deviceBeacon);
devicesRouter.post("/:id/command", authJwt, requireTenant, createDeviceCommand);
devicesRouter.post("/poll", deviceAuth, pollCommands);
devicesRouter.post("/ack", deviceAuth, ackCommand);