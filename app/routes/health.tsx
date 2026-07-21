import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";

/**
 * Unauthenticated health check for load balancers and monitoring.
 * Returns 200 if app and DB are reachable.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const deep = url.searchParams.get("deep") === "1";

  if (!deep) {
    return json({ status: "ok", timestamp: new Date().toISOString() }, 200);
  }

  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    return json(
      {
        status: "ok",
        timestamp: new Date().toISOString(),
        database: "connected",
      },
      200
    );
  } catch (err) {
    return json(
      {
        status: "degraded",
        timestamp: new Date().toISOString(),
        database: "error",
        error: err instanceof Error ? err.message : "Unknown error",
      },
      503
    );
  }
}
