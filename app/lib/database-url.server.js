/**
 * Resolve DATABASE_URL before any Prisma client is constructed.
 *
 * The schema takes its URL from `env("DATABASE_URL")` rather than a literal, so
 * that a deployment can point at a durable database instead of a SQLite file
 * inside the container image. But only the *Prisma CLI* reads `.env` — plain
 * `node prisma/seed.js` does not, and neither does Vite's dev server for
 * server-side `process.env`. So every entry point has to do it itself.
 *
 * Then the two environments part ways deliberately:
 *
 *   - Local dev and tests fall back to `file:dev.sqlite`, exactly what the
 *     schema used to hardcode. Relative paths resolve against prisma/, so this
 *     is prisma/dev.sqlite. A clone runs with no setup.
 *   - Production **throws**. Defaulting there is what made the original bug
 *     invisible: the app came up, wrote to a file inside the container, and lost
 *     every shop on the next redeploy. Failing at boot with the variable's name
 *     in the message is the whole point of the change.
 *
 * `.server.js` per §10 — it decides where the database lives. prisma/seed.js
 * imports it with an explicit path and extension, which plain node ESM resolves.
 */
const LOCAL_DEFAULT = "file:dev.sqlite";

export function resolveDatabaseUrl(env = process.env) {
  if (env.DATABASE_URL) return env.DATABASE_URL;

  // Node 20.12+ / 22. Absent or unreadable .env is not an error — the fallback
  // below is the normal path for a fresh clone.
  try {
    process.loadEnvFile();
  } catch {
    /* no .env */
  }

  if (env.DATABASE_URL) return env.DATABASE_URL;

  if (env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_URL is not set. Production must point Prisma at a durable " +
        "database — a relative SQLite path lives inside the container image and " +
        "is recreated empty on every redeploy. See CLAUDE.md §4.",
    );
  }

  env.DATABASE_URL = LOCAL_DEFAULT;
  return LOCAL_DEFAULT;
}
