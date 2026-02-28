"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
// Hot-reload / dev alatt ne nyissunk sok connectiont
const prisma = global.__prisma ?? new client_1.PrismaClient();
if (process.env.NODE_ENV !== "production") {
    global.__prisma = prisma;
}
exports.default = prisma;
