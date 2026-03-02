"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.playerDeviceRouter = void 0;
const express_1 = require("express");
const authJwt_1 = require("../../middleware/authJwt");
const tenant_1 = require("../../middleware/tenant");
const player_device_controller_1 = require("./player.device.controller");
exports.playerDeviceRouter = (0, express_1.Router)();
// csak belépett user + tenant kell (PLAYER tenantId nem lehet null)
exports.playerDeviceRouter.post("/register", authJwt_1.authJwt, tenant_1.requireTenant, player_device_controller_1.registerPlayerDevice);
exports.playerDeviceRouter.post("/beacon", authJwt_1.authJwt, tenant_1.requireTenant, player_device_controller_1.beaconPlayerDevice);
exports.playerDeviceRouter.post("/poll", authJwt_1.authJwt, tenant_1.requireTenant, player_device_controller_1.pollPlayerCommands);
exports.playerDeviceRouter.post("/ack", authJwt_1.authJwt, tenant_1.requireTenant, player_device_controller_1.ackPlayerCommand);
