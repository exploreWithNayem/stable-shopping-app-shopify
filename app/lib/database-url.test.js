import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { resolveDatabaseUrl } from "./database-url.server";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (file) => readFileSync(join(root, file), "utf8");

/*
 * The datasource used to be `url = "file:dev.sqlite"` — a literal, so the Docker
 * image carried a SQLite file inside the container that was recreated empty on
 * every redeploy, silently. Making it an env var only helps if the missing case
 * is loud in production and quiet locally, which is what these pin.
 */
describe("resolveDatabaseUrl", () => {
  test("an explicit value always wins", () => {
    const env = { DATABASE_URL: "postgresql://host/db", NODE_ENV: "production" };
    expect(resolveDatabaseUrl(env)).toBe("postgresql://host/db");
  });

  test("local dev falls back to the file the schema used to hardcode", () => {
    // A fresh clone with no .env has to run `npm test` and `npm run seed`.
    const env = { NODE_ENV: "development" };
    expect(resolveDatabaseUrl(env)).toBe("file:dev.sqlite");
    // Written back, because Prisma reads process.env when the client is built.
    expect(env.DATABASE_URL).toBe("file:dev.sqlite");
  });

  test("production throws rather than defaulting", () => {
    // Defaulting here is exactly what made the original bug invisible: the app
    // came up, wrote to a doomed file, and lost every shop on redeploy.
    expect(() => resolveDatabaseUrl({ NODE_ENV: "production" })).toThrow(
      /DATABASE_URL is not set/,
    );
  });

  test("the production error names the variable and says why", () => {
    let message = "";
    try {
      resolveDatabaseUrl({ NODE_ENV: "production" });
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("redeploy");
  });
});

/*
 * The regression these exist for: making the datasource env-driven broke
 * `shopify app dev`. The Prisma CLI is a separate process — it never loads
 * app/db.server.js, so the fallback above cannot reach it, and it only reads
 * `.env` if one happens to exist. shopify.web.toml shells out to it twice
 * before the app boots, so a fresh clone died at `prisma generate` with P1012.
 *
 * scripts/prisma.js applies the same rule and everything goes through it.
 */
describe("the Prisma CLI goes through the wrapper", () => {
  test("the wrapper exists and resolves the URL before spawning", () => {
    expect(existsSync(join(root, "scripts", "prisma.js"))).toBe(true);
    const wrapper = read("scripts/prisma.js");
    expect(wrapper).toContain("resolveDatabaseUrl()");
    // Order matters: Prisma reads the env var when it validates the schema.
    expect(wrapper.indexOf("resolveDatabaseUrl()")).toBeLessThan(
      wrapper.indexOf("spawnSync("),
    );
  });

  test("shopify.web.toml never invokes the CLI directly", () => {
    // This file is what `shopify app dev` runs, and it ran `npm exec prisma …`.
    const commands = read("shopify.web.toml");
    expect(commands).not.toMatch(/npm exec prisma/);
    expect(commands).not.toMatch(/(^|[^/])\bnpx prisma/);
    expect(commands).toContain("npm run prisma --");
  });

  test("no npm script invokes the CLI directly", () => {
    const { scripts } = JSON.parse(read("package.json"));
    for (const [name, command] of Object.entries(scripts)) {
      // `prisma` itself is the wrapper entry point.
      if (name === "prisma") {
        expect(command).toContain("scripts/prisma.js");
        continue;
      }
      expect(command, `${name} calls the Prisma CLI directly`).not.toMatch(
        /(^|&&\s*|\s)(npm exec |npx )?prisma\s/,
      );
    }
  });
});
