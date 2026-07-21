import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { isAlreadyProcessed, markProcessed } from "../lib/webhook-idempotency.server";
import { logger } from "../lib/logger.server";
import { fullSync } from "../services/sync.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin, topic, webhookId } = await authenticate.webhook(request);

  if (await isAlreadyProcessed(webhookId)) {
    return new Response(null, { status: 200 });
  }

  const shopRecord = await prisma.shop.findUnique({ where: { domain: shop } });
  if (!shopRecord) {
    logger.warn("Product create webhook: shop not found", { shop });
    return new Response(null, { status: 200 });
  }

  try {
    await fullSync(admin, shopRecord.id);
    await markProcessed(webhookId, shopRecord.id, topic);
  } catch (err) {
    logger.error("Product create webhook failed", {
      shop,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Response("Internal error", { status: 500 });
  }

  return new Response(null, { status: 200 });
};
