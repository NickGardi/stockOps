import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { isAlreadyProcessed, markProcessed } from "../lib/webhook-idempotency.server";
import { logger } from "../lib/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload } = await authenticate.webhook(request);

  if (await isAlreadyProcessed(webhookId)) {
    return new Response(null, { status: 200 });
  }

  const shopRecord = await prisma.shop.findUnique({ where: { domain: shop } });
  if (!shopRecord) {
    logger.warn("Product delete webhook: shop not found", { shop });
    return new Response(null, { status: 200 });
  }

  try {
    const id = payload?.admin_graphql_api_id ?? payload?.id;
    if (id) {
      const shopifyProductId = String(id).replace("gid://shopify/Product/", "");
      if (shopifyProductId) {
        await prisma.product.updateMany({
          where: { shopId: shopRecord.id, shopifyProductId },
          data: { deletedAt: new Date(), status: "ARCHIVED" },
        });
      }
    }
    await markProcessed(webhookId, shopRecord.id, topic);
  } catch (err) {
    logger.error("Product delete webhook failed", {
      shop,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Response("Internal error", { status: 500 });
  }

  return new Response(null, { status: 200 });
};
