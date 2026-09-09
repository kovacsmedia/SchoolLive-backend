import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// EGYETLEN PrismaClient példány az egész folyamatra.
//
// Korábban két külön modul hozott létre egy-egy klienst – ez a fájl (named
// export) és a `src/prisma.ts` (default export) –, a modulok pedig vegyesen
// importálták őket. Így egy processzben KÉT független connection pool futott,
// dupla annyi Postgres kapcsolattal (PgBouncer mögött is), és a dev-időben
// szánt globális újrahasznosítás csak az egyikre vonatkozott.
// A `src/prisma.ts` mostantól ezt a példányt exportálja tovább.
export const prisma = global.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}
