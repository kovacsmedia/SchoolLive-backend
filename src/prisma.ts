// Visszafelé kompatibilis default export – a példány maga a `prisma/client.ts`
// singletonja (ld. ott a magyarázatot). Korábban ez a fájl SAJÁT PrismaClientet
// példányosított, így egy processzben két connection pool futott.
export { prisma as default } from "./prisma/client";
