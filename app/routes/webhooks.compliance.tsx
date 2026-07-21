import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  handleCustomersDataRequest,
  handleCustomersRedact,
  purgeShopByDomain,
} from "../services/compliance.server";
import { logger } from "../lib/logger.server";

/**
 * Mandatory App Store compliance webhooks:
 * customers/data_request, customers/redact, shop/redact
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  const normalized = String(topic || "").toUpperCase().replace(/\//g, "_");

  try {
    if (normalized === "CUSTOMERS_DATA_REQUEST") {
      await handleCustomersDataRequest(payload as Parameters<typeof handleCustomersDataRequest>[0]);
    } else if (normalized === "CUSTOMERS_REDACT") {
      await handleCustomersRedact(payload as Parameters<typeof handleCustomersRedact>[0]);
    } else if (normalized === "SHOP_REDACT") {
      const domain =
        (payload as { shop_domain?: string })?.shop_domain || shop;
      if (domain) {
        await purgeShopByDomain(domain);
      }
    } else {
      logger.warn("Unknown compliance webhook topic", { topic, shop });
    }
  } catch (err) {
    logger.error("Compliance webhook failed", {
      topic,
      shop,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Response("Internal error", { status: 500 });
  }

  return new Response(null, { status: 200 });
};
