/**
 * Stock takes: count inventory at a location and create adjustments.
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { graphqlWithRetry } from "../lib/shopify-graphql.server";
import { logger } from "../lib/logger.server";

export async function finishStockTake(
  admin: AdminApiContext,
  shopId: string,
  stockTakeId: string
): Promise<{ success: boolean; error?: string }> {
  const stockTake = await prisma.stockTake.findFirst({
    where: { id: stockTakeId, shopId },
    include: {
      location: true,
      lines: { include: { variant: true } },
    },
  });
  if (!stockTake || stockTake.status !== "IN_PROGRESS") {
    return { success: false, error: "Stock take not found or not in progress" };
  }

  const changes: Array<{ inventoryItemId: string; locationId: string; delta: number }> = [];
  const locGid = `gid://shopify/Location/${stockTake.location.shopifyLocationId}`;
  const adjustmentLines: Array<{ variantId: string; quantityDelta: number }> = [];

  for (const line of stockTake.lines) {
    const delta = line.countedQty - line.expectedQty;
    if (delta === 0) continue;

    const invItemId = line.variant.shopifyInventoryItemId;
    if (!invItemId) continue;

    changes.push({
      inventoryItemId: `gid://shopify/InventoryItem/${invItemId}`,
      locationId: locGid,
      delta,
    });
    adjustmentLines.push({ variantId: line.variantId, quantityDelta: delta });
  }

  if (changes.length > 0) {
    const mutation = `#graphql
      mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) {
          inventoryAdjustmentGroup { createdAt }
          userErrors { field message }
        }
      }
    `;

    try {
      const { data } = await graphqlWithRetry<{
        inventoryAdjustQuantities?: {
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(admin as Parameters<typeof graphqlWithRetry>[0], mutation, {
        variables: { input: { name: "available", reason: "cycle_count_available", changes } },
      });

      const errors = data?.inventoryAdjustQuantities?.userErrors ?? [];
      if (errors.length > 0) {
        return { success: false, error: errors.map((e) => e.message).join("; ") };
      }
    } catch (err) {
      logger.error("Stock take finish failed", {
        stockTakeId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
    }
  }

  await prisma.$transaction([
    prisma.stockAdjustment.create({
      data: {
        shopId,
        locationId: stockTake.locationId,
        reasonCode: "STOCK_TAKE",
        notes: `From stock take ${stockTake.name}`,
        performedAt: new Date(),
        performedBy: null,
        lines: {
          create: adjustmentLines.map((l) => ({
            variantId: l.variantId,
            quantityDelta: l.quantityDelta,
          })),
        },
      },
    }),
    prisma.stockTake.update({
      where: { id: stockTakeId },
      data: { status: "COMPLETED" },
    }),
  ]);

  for (const line of adjustmentLines) {
    await prisma.inventoryLevel.upsert({
      where: { variantId_locationId: { variantId: line.variantId, locationId: stockTake.locationId } },
      create: {
        shopId,
        variantId: line.variantId,
        locationId: stockTake.locationId,
        available: line.quantityDelta > 0 ? line.quantityDelta : 0,
      },
      update: {
        available: { increment: line.quantityDelta },
        updatedAt: new Date(),
      },
    });
  }

  return { success: true };
}
