import { defineConfig } from "vitest/config";

/**
 * Separate from vite.config.js on purpose: that config loads the reactRouter()
 * plugin, which expects to be building an app rather than running tests.
 *
 * Integration tests run against the local prisma/dev.sqlite (the datasource URL
 * is hardcoded in schema.prisma). Each test file scopes its data to its own
 * shop domain and cleans up after itself, and fileParallelism is off so
 * concurrent writers don't hit SQLite's database-level write lock.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.test.{js,jsx}", "tests/**/*.test.js"],
    fileParallelism: false,
  },
});
