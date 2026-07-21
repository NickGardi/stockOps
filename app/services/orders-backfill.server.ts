/**
 * Backfill sales_daily from paid Shopify orders.
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { graphqlWithRetry } from "../lib/shopify-graphql.server";
import { recordSales } from "./sales-velocity.server";
import { logger } from "../lib/logger.server";

export type OrdersBackfillResult = {
  ok: boolean;
  totalProcessed: number;
  blocked?: boolean;
  error?: string;
};

function isOrderAccessBlocked(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes("protected customer data") ||
    lower.includes("access denied") ||
    lower.includes("not approved") ||
    lower.includes("forbidden") ||
    lower.includes("403") ||
    lower.includes("orders field") ||
    lower.includes("access to the orders")
  );
}

export async function backfillOrders(
  admin: AdminApiContext,
  shopId: string,
  days = 60
): Promise<OrdersBackfillResult> {
  logger.info("Starting orders backfill", { shopId, days });

  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);
  const sinceStr = since.toISOString().split("T")[0];

  try {
    // Replace (not add) sales data for the backfill window to avoid double-counting
    // when Resync is run multiple times
    await prisma.salesDaily.deleteMany({
      where: { shopId, date: { gte: since } },
    });

    let cursor: string | null = null;
    let hasNext = true;
    let totalProcessed = 0;

    while (hasNext) {
      const query = `#graphql
        query Orders($after: String) {
          orders(
            first: 50
            after: $after
            query: "processed_at:>=${sinceStr} financial_status:paid"
          ) {
            edges {
              node {
                id
                processedAt
                lineItems(first: 100) {
                  edges {
                    node {
                      variant { id }
                      quantity
                    }
                  }
                }
              }
              cursor
            }
            pageInfo { hasNextPage }
          }
        }
      `;

      type OrdersResult = {
        orders: {
          edges: Array<{
            node: {
              processedAt: string;
              lineItems: {
                edges: Array<{
                  node: { variant: { id: string } | null; quantity: number };
                }>;
              };
            };
            cursor: string;
          }>;
          pageInfo: { hasNextPage: boolean };
        };
      };

      const { data } = await graphqlWithRetry<OrdersResult>(
        admin as Parameters<typeof graphqlWithRetry>[0],
        query,
        { variables: { after: cursor } }
      );

      const orders = data?.orders;
      if (!orders) break;

      for (const edge of orders.edges) {
        const order = edge.node;
        const processedAt = new Date(order.processedAt);
        const dateOnly = new Date(
          processedAt.getFullYear(),
          processedAt.getMonth(),
          processedAt.getDate()
        );

        for (const li of order.lineItems.edges) {
          const variantId = li.node.variant?.id;
          if (!variantId) continue;

          const shopifyVariantId = variantId.replace("gid://shopify/ProductVariant/", "");
          const variant = await prisma.variant.findFirst({
            where: { shopId, shopifyVariantId },
          });
          if (!variant) continue;

          await recordSales(shopId, variant.id, dateOnly, li.node.quantity);
          totalProcessed++;
        }
      }

      cursor = orders.edges[orders.edges.length - 1]?.cursor ?? null;
      hasNext = orders.pageInfo.hasNextPage && !!cursor;
    }

    logger.info("Orders backfill complete", { shopId, totalProcessed });
    return { ok: true, totalProcessed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Orders backfill failed", { shopId, error: message });
    if (isOrderAccessBlocked(err)) {
      return {
        ok: false,
        totalProcessed: 0,
        blocked: true,
        error: message,
      };
    }
    return { ok: false, totalProcessed: 0, error: message };
  }
}
