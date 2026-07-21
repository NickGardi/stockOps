import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { purgeShopByDomain } from "../services/compliance.server";
import { logger } from "../lib/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  logger.info("App uninstalled webhook received", { shop, topic });

  // Immediate cleanup on uninstall. shop/redact (48h later) is a safety net.
  try {
    await purgeShopByDomain(shop);
  } catch (err) {
    logger.error("Uninstall purge failed", {
      shop,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Response("Internal error", { status: 500 });
  }

  return new Response(null, { status: 200 });
};
