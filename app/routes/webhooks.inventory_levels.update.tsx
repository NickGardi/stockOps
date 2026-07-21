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
    logger.warn("Inventory levels update webhook: shop not found", { shop });
    return new Response(null, { status: 200 });
  }

  try {
    const inventoryItemId = payload?.inventory_item_id != null ? String(payload.inventory_item_id) : null;
    const locationId = payload?.location_id != null ? String(payload.location_id) : null;
    const available = typeof payload?.available === "number" ? payload.available : 0;

    if (inventoryItemId && locationId) {
      const variant = await prisma.variant.findFirst({
        where: { shopId: shopRecord.id, shopifyInventoryItemId: inventoryItemId },
      });
      const location = await prisma.location.findFirst({
        where: { shopId: shopRecord.id, shopifyLocationId: locationId },
      });

      if (variant && location) {
        await prisma.inventoryLevel.upsert({
          where: {
            variantId_locationId: { variantId: variant.id, locationId: location.id },
          },
          create: {
            shopId: shopRecord.id,
            variantId: variant.id,
            locationId: location.id,
            available,
          },
          update: { available, updatedAt: new Date() },
        });
      }
    }

    await markProcessed(webhookId, shopRecord.id, topic);
  } catch (err) {
    logger.error("Inventory levels update webhook failed", {
      shop,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Response("Internal error", { status: 500 });
  }

  return new Response(null, { status: 200 });
};
