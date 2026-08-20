#!/usr/bin/env node
/**
 * Run the Prisma CLI with DATABASE_URL resolved the same way the app resolves it.
 *
 * Why this exists: the datasource is `env("DATABASE_URL")` so that production
 * cannot silently write to a SQLite file inside its own container image (see
 * CLAUDE.md §4). But the Prisma CLI is a separate process — it never loads
 * app/db.server.js, so it never sees the fallback in
 * app/lib/database-url.server.js, and it only reads `.env` if one happens to
 * exist. `shopify app dev` shells out to it twice before the app ever boots, so
 * without this a fresh clone fails at `prisma generate` with P1012 before
 * anything else runs.
 *
 * Resolving it here keeps one source of truth for the rule: fall back to the
 * local SQLite file in development, throw in production.
 *
 * Usage: node scripts/prisma.js <any prisma args>
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolveDatabaseUrl } from "../app/lib/database-url.server.js";

resolveDatabaseUrl();

// Spawned through node with the CLI's own entry point rather than through
// node_modules/.bin, which needs a shell on Windows.
const cli = createRequire(import.meta.url).resolve("prisma/build/index.js");

const { status } = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

process.exit(status ?? 1);
