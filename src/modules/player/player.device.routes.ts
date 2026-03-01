import { Router } from "express";
import { authJwt } from "../../middleware/authJwt";
import { requireTenant } from "../../middleware/tenant";
import {
  registerPlayerDevice,
  beaconPlayerDevice,
  pollPlayerCommands,
  ackPlayerCommand,
} from "./player.device.controller";

export const playerDeviceRouter = Router();

// csak belépett user + tenant kell (PLAYER tenantId nem lehet null)
playerDeviceRouter.post("/register", authJwt, requireTenant, registerPlayerDevice);
playerDeviceRouter.post("/beacon", authJwt, requireTenant, beaconPlayerDevice);
playerDeviceRouter.post("/poll", authJwt, requireTenant, pollPlayerCommands);
playerDeviceRouter.post("/ack", authJwt, requireTenant, ackPlayerCommand);