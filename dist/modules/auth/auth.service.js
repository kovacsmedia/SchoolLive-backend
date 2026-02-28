"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.login = login;
exports.getMe = getMe;
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const client_1 = require("../../prisma/client");
const env_1 = require("../../config/env");
async function login(email, password) {
    const user = await client_1.prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive)
        return null;
    const ok = await bcrypt_1.default.compare(password, user.passwordHash);
    if (!ok)
        return null;
    const payload = {
        sub: user.id,
        role: user.role,
        tenantId: user.tenantId ?? null
    };
    const token = jsonwebtoken_1.default.sign(payload, env_1.env.JWT_ACCESS_SECRET, { expiresIn: env_1.env.JWT_ACCESS_TTL });
    return {
        accessToken: token,
        user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenantId ?? null }
    };
}
async function getMe(userId) {
    return client_1.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, role: true, tenantId: true, isActive: true }
    });
}
