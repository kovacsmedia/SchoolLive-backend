"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authJwt = authJwt;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../config/env");
function authJwt(req, res, next) {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token)
        return res.status(401).json({ error: "Missing token" });
    if (!env_1.env.JWT_ACCESS_SECRET)
        return res.status(500).json({ error: "JWT secret not set" });
    try {
        const decoded = jsonwebtoken_1.default.verify(token, env_1.env.JWT_ACCESS_SECRET);
        req.user = decoded;
        next();
    }
    catch {
        return res.status(401).json({ error: "Invalid token" });
    }
}
