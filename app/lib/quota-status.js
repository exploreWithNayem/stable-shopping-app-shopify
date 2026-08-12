import { useRouteLoaderData } from "react-router";

/**
 * Quota status for the current shop, loaded once by the /app layout route and
 * read by any page beneath it.
 *
 * Lives here rather than in app/routes/app.jsx so components can pull it in
 * without importing a route module. Returns null if the layout loader has not
 * run (it always has, in practice, for pages under /app).
 */
export function useQuotaStatus() {
  return useRouteLoaderData("routes/app")?.quota ?? null;
}
