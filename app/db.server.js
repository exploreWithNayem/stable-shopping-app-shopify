import { PrismaClient } from "@prisma/client";
import { resolveDatabaseUrl } from "./lib/database-url.server";

// Must run before the client is constructed — Prisma reads the datasource env
// var at that moment, and nothing else in the process has loaded .env.
resolveDatabaseUrl();

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

export default prisma;
