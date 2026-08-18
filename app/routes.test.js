import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * Guards the flat-route tree itself.
 *
 * `app.recommendations.jsx` used to sit above `app.recommendations.$productId.jsx`
 * as its layout, and because the list page renders no <Outlet /> the override
 * editor was unreachable: /app/recommendations/123 ran the editor's loader and
 * then rendered the list again. Nothing in the app crashed, so nothing caught it
 * — hence this test rather than a render test.
 */

const appDirectory = fileURLToPath(new URL(".", import.meta.url));

let routes;

beforeAll(async () => {
  // flatRoutes() reads the app directory from a global the React Router CLI sets.
  // eslint-disable-next-line no-undef
  globalThis.__reactRouterAppDirectory = appDirectory;
  const { flatRoutes } = await import("@react-router/fs-routes");
  routes = await flatRoutes();
});

function flatten(list, parent = null) {
  return list.flatMap((route) => [
    { ...route, parent },
    ...flatten(route.children ?? [], route),
  ]);
}

describe("route tree", () => {
  test("every route with children renders an Outlet", () => {
    const offenders = flatten(routes)
      .filter((route) => (route.children ?? []).length > 0)
      .filter((route) => {
        const source = readFileSync(`${appDirectory}${route.file}`, "utf8");
        return !source.includes("Outlet");
      })
      .map((route) => route.file);

    expect(offenders).toEqual([]);
  });

  test("the override editor is reachable at /app/recommendations/:productId", () => {
    const editor = flatten(routes).find((route) =>
      route.file.endsWith("app.recommendations.$productId.jsx"),
    );

    expect(editor).toBeDefined();

    // Full path from the root, so a future re-nesting shows up here.
    const segments = [];
    for (let node = editor; node; node = node.parent) {
      if (node.path) segments.unshift(node.path);
    }
    expect(segments.join("/")).toBe("app/recommendations/:productId");
  });
});
