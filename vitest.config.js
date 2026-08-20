import { defineConfig } from "vitest/config";

/**
 * Separate from vite.config.js on purpose: that config loads the reactRouter()
 * plugin, which expects to be building an app rather than running tests.
 *
 * Integration tests run against the local prisma/dev.sqlite (DATABASE_URL is
 * pinned below rather than read from .env). Each test file scopes its data to its own
 * shop domain and cleans up after itself, and fileParallelism is off so
 * concurrent writers don't hit SQLite's database-level write lock.
 */
export default defineConfig({
  test: {
    environment: "node",
    /*
     * The datasource URL is an env var (so production can point somewhere
     * durable), and vitest does not read .env. Pinning it here keeps `npm test`
     * working on a fresh clone and guarantees every run hits the same local
     * file — relative paths resolve against prisma/, so this is
     * prisma/dev.sqlite.
     */
    env: { DATABASE_URL: "file:dev.sqlite" },
    include: ["app/**/*.test.{js,jsx}", "tests/**/*.test.js"],
    fileParallelism: false,
  },
});
