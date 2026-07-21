import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { isAlreadyProcessed, markProcessed } from "../lib/webhook-idempotency.server";
import { recordSales } from "../services/sales-velocity.server";
import { logger } from "../lib/logger.server";

function normalizeShopifyVariantId(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  return String(raw).replace(/^gid:\/\/shopify\/ProductVariant\//, "").trim() || null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload } = await authenticate.webhook(request);

  if (await isAlreadyProcessed(webhookId)) {
    return new Response(null, { status: 200 });
  }

  const shopRecord = await prisma.shop.findUnique({ where: { domain: shop } });
  if (!shopRecord) {
    logger.warn("Orders paid webhook: shop not found", { shop });
    return new Response(null, { status: 200 });
  }

  try {
    const processedAt = payload?.processed_at ?? payload?.created_at ?? new Date().toISOString();
    const date = new Date(processedAt);
    const lineItems = payload?.line_items ?? payload?.lineItems ?? [];

    let recorded = 0;
    for (const item of lineItems) {
      const shopifyVariantId = normalizeShopifyVariantId(
        item.variant_id ?? item.variant?.admin_graphql_api_id ?? item.variant?.id
      );
      if (!shopifyVariantId) continue;

      const variant = await prisma.variant.findFirst({
        where: { shopId: shopRecord.id, shopifyVariantId },
      });
      if (!variant) continue;

      const qty = Number(item.quantity ?? 0) || 0;
      if (qty > 0) {
        await recordSales(shopRecord.id, variant.id, date, qty);
        recorded += 1;
      }
    }

    await markProcessed(webhookId, shopRecord.id, topic);
    logger.info("Orders paid webhook processed", {
      shop,
      webhookId,
      lineItems: lineItems.length,
      recorded,
    });
  } catch (err) {
    logger.error("Orders paid webhook failed", {
      shop,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Response("Internal error", { status: 500 });
  }

  return new Response(null, { status: 200 });
};
