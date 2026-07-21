/**
 * Stock adjustments: manual inventory corrections.
 * Shopify inventoryAdjustQuantities requires valid name (quantity state) and reason codes.
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { graphqlWithRetry } from "../lib/shopify-graphql.server";
import { logger } from "../lib/logger.server";

export async function performStockAdjustment(
  admin: AdminApiContext,
  shopId: string,
  adjustmentId: string
): Promise<{ success: boolean; error?: string }> {
  const adjustment = await prisma.stockAdjustment.findFirst({
    where: { id: adjustmentId, shopId },
    include: {
      location: true,
      lines: { include: { variant: true } },
    },
  });
  if (!adjustment) return { success: false, error: "Adjustment not found" };

  const changes: Array<{ inventoryItemId: string; locationId: string; delta: number }> = [];
  const locGid = `gid://shopify/Location/${adjustment.location.shopifyLocationId}`;

  for (const line of adjustment.lines) {
    if (line.quantityDelta === 0) continue;

    const invItemId = line.variant.shopifyInventoryItemId;
    if (!invItemId) continue;

    changes.push({
      inventoryItemId: `gid://shopify/InventoryItem/${invItemId}`,
      locationId: locGid,
      delta: line.quantityDelta,
    });
  }

  if (changes.length === 0) {
    return { success: true };
  }

  const VALID_REASONS = [
    "correction",
    "cycle_count_available",
    "damaged",
    "movement_canceled",
    "movement_created",
    "movement_received",
    "movement_updated",
    "other",
    "promotion",
    "quality_control",
    "received",
    "reservation_created",
    "reservation_deleted",
    "reservation_updated",
    "restock",
    "safety_stock",
    "shrinkage",
  ] as const;
  const reason =
    adjustment.reasonCode && VALID_REASONS.includes(adjustment.reasonCode as (typeof VALID_REASONS)[number])
      ? adjustment.reasonCode
      : "correction";

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
      variables: { input: { name: "available", reason, changes } },
    });

    const errors = data?.inventoryAdjustQuantities?.userErrors ?? [];
    if (errors.length > 0) {
      return { success: false, error: errors.map((e) => e.message).join("; ") };
    }

    const idempotencyKey = `adjustment-${adjustmentId}`;
    await prisma.$transaction([
      ...adjustment.lines
        .filter((l) => l.quantityDelta !== 0)
        .map((line) =>
          prisma.inventoryEvent.create({
            data: {
              shopId,
              idempotencyKey: `${idempotencyKey}-${line.id}`,
              variantId: line.variantId,
              locationId: adjustment.locationId,
              quantityDelta: line.quantityDelta,
              source: "STOCK_ADJUSTMENT",
              referenceId: adjustmentId,
            },
          })
        ),
      prisma.stockAdjustment.update({
        where: { id: adjustmentId },
        data: { performedAt: new Date() },
      }),
    ]);

    for (const line of adjustment.lines) {
      if (line.quantityDelta === 0) continue;
      await prisma.inventoryLevel.upsert({
        where: { variantId_locationId: { variantId: line.variantId, locationId: adjustment.locationId } },
        create: {
          shopId,
          variantId: line.variantId,
          locationId: adjustment.locationId,
          available: Math.max(0, line.quantityDelta),
        },
        update: {
          available: { increment: line.quantityDelta },
          updatedAt: new Date(),
        },
      });
    }

    return { success: true };
  } catch (err) {
    logger.error("Stock adjustment failed", {
      adjustmentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
