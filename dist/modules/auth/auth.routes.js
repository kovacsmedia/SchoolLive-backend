"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRouter = void 0;
const express_1 = require("express");
const auth_controller_1 = require("./auth.controller");
const authJwt_1 = require("../../middleware/authJwt");
exports.authRouter = (0, express_1.Router)();
exports.authRouter.post("/login", auth_controller_1.postLogin);
exports.authRouter.post("/logout", auth_controller_1.postLogout); // token bodyból vagy headerből
exports.authRouter.get("/me", authJwt_1.authJwt, auth_controller_1.getMeHandler);
