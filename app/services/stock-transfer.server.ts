/**
 * Stock transfers: move inventory between locations via Shopify inventoryAdjustQuantities.
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { formatTransferDisplayNumber } from "../lib/format-po";
import { graphqlWithRetry } from "../lib/shopify-graphql.server";
import { ensureInventoryActivatedAtLocation } from "../lib/inventory-activate.server";
import { logger } from "../lib/logger.server";

export { formatTransferDisplayNumber };

export type TransferActionResult = {
  success: boolean;
  error?: string;
  message?: string;
  unitsMoved?: number;
  inventoryReversed?: boolean;
};

type InventoryChange = {
  inventoryItemId: string;
  locationId: string;
  delta: number;
};

type LocalLevelUpdate = {
  variantId: string;
  locationId: string;
  delta: number;
};

type LocalEvent = {
  idempotencyKey: string;
  variantId: string;
  locationId: string;
  quantityDelta: number;
};

async function adjustShopifyInventory(
  admin: AdminApiContext,
  changes: InventoryChange[],
  reason: "correction" | "restock" = "correction"
): Promise<{ success: boolean; error?: string }> {
  if (changes.length === 0) return { success: true };

  // Shopify requires items to be activated at a location before quantity can increase there
  const activatedPairs = new Set<string>();
  for (const c of changes) {
    if (c.delta <= 0) continue;
    const key = `${c.inventoryItemId}|${c.locationId}`;
    if (activatedPairs.has(key)) continue;
    activatedPairs.add(key);
    const activated = await ensureInventoryActivatedAtLocation(
      admin as Parameters<typeof ensureInventoryActivatedAtLocation>[0],
      c.inventoryItemId,
      c.locationId
    );
    if (!activated.success) {
      return {
        success: false,
        error: activated.error ?? "Could not enable inventory at the destination location in Shopify.",
      };
    }
  }

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
      inventoryAdjustQuantities?: { userErrors: Array<{ field: string[]; message: string }> };
    }>(admin as Parameters<typeof graphqlWithRetry>[0], mutation, {
      variables: { input: { name: "available", reason, changes } },
    });

    const errors = data?.inventoryAdjustQuantities?.userErrors ?? [];
    if (errors.length > 0) {
      return { success: false, error: errors.map((e) => e.message).join("; ") };
    }
    return { success: true };
  } catch (err) {
    logger.error("Transfer inventory adjust failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

async function applyLocalInventoryUpdates(
  shopId: string,
  transferId: string,
  levelUpdates: LocalLevelUpdate[],
  events: LocalEvent[]
): Promise<void> {
  if (events.length > 0) {
    await prisma.$transaction(
      events.map((e) =>
        prisma.inventoryEvent.create({
          data: {
            shopId,
            idempotencyKey: e.idempotencyKey,
            variantId: e.variantId,
            locationId: e.locationId,
            quantityDelta: e.quantityDelta,
            source: "STOCK_TRANSFER",
            referenceId: transferId,
          },
        })
      )
    );
  }

  for (const u of levelUpdates) {
    const existing = await prisma.inventoryLevel.findUnique({
      where: { variantId_locationId: { variantId: u.variantId, locationId: u.locationId } },
    });
    if (existing) {
      await prisma.inventoryLevel.update({
        where: { variantId_locationId: { variantId: u.variantId, locationId: u.locationId } },
        data: { available: { increment: u.delta }, updatedAt: new Date() },
      });
    } else if (u.delta > 0) {
      await prisma.inventoryLevel.create({
        data: {
          shopId,
          variantId: u.variantId,
          locationId: u.locationId,
          available: u.delta,
        },
      });
    }
  }
}

function buildChangesForLines(
  lines: Array<{ id: string; variantId: string; quantity: number; variant: { shopifyInventoryItemId: string | null; title: string } }>,
  locationGid: string,
  deltaSign: 1 | -1
): {
  changes: InventoryChange[];
  levelUpdates: LocalLevelUpdate[];
  events: LocalEvent[];
  units: number;
  missingVariants: string[];
} {
  const changes: InventoryChange[] = [];
  const levelUpdates: LocalLevelUpdate[] = [];
  const events: LocalEvent[] = [];
  const missingVariants: string[] = [];
  let units = 0;

  for (const line of lines) {
    const invItemId = line.variant.shopifyInventoryItemId;
    if (!invItemId) {
      missingVariants.push(line.variant.title);
      continue;
    }
    units += line.quantity;
    changes.push({
      inventoryItemId: `gid://shopify/InventoryItem/${invItemId}`,
      locationId: locationGid,
      delta: deltaSign * line.quantity,
    });
  }

  return { changes, levelUpdates, events, units, missingVariants };
}

export async function getNextTransferNumber(shopId: string): Promise<number> {
  const needBackfill = await prisma.stockTransfer.findMany({
    where: { shopId, transferNumber: 0 },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (needBackfill.length > 0) {
    const max = await prisma.stockTransfer.findFirst({
      where: { shopId, transferNumber: { gt: 0 } },
      orderBy: { transferNumber: "desc" },
      select: { transferNumber: true },
    });
    let next = (max?.transferNumber ?? 0) + 1;
    for (const t of needBackfill) {
      await prisma.stockTransfer.update({
        where: { id: t.id },
        data: { transferNumber: next++ },
      });
    }
  }
  const max = await prisma.stockTransfer.findFirst({
    where: { shopId },
    orderBy: { transferNumber: "desc" },
    select: { transferNumber: true },
  });
  return (max?.transferNumber ?? 0) + 1;
}

export async function sendTransfer(
  admin: AdminApiContext,
  shopId: string,
  transferId: string
): Promise<TransferActionResult> {
  const transfer = await prisma.stockTransfer.findFirst({
    where: { id: transferId, shopId },
    include: {
      sourceLocation: true,
      lines: { include: { variant: true } },
    },
  });
  if (!transfer || transfer.status !== "DRAFT") {
    return { success: false, error: "Transfer not found or not in draft" };
  }
  if (transfer.lines.length === 0) {
    return { success: false, error: "Add at least one product line before sending" };
  }

  for (const line of transfer.lines) {
    const level = await prisma.inventoryLevel.findUnique({
      where: {
        variantId_locationId: { variantId: line.variantId, locationId: transfer.sourceLocationId },
      },
    });
    const available = level?.available ?? 0;
    if (line.quantity > available) {
      const label = `${line.variant.title}`;
      return {
        success: false,
        error: `Not enough stock at ${transfer.sourceLocation.name} for ${label}. Available: ${available}, requested: ${line.quantity}.`,
      };
    }
  }

  const sourceGid = `gid://shopify/Location/${transfer.sourceLocation.shopifyLocationId}`;
  const { changes, missingVariants, units } = buildChangesForLines(
    transfer.lines,
    sourceGid,
    -1
  );

  if (missingVariants.length > 0) {
    return {
      success: false,
      error: `These variants are missing Shopify inventory items and cannot be transferred: ${missingVariants.join(", ")}`,
    };
  }
  if (changes.length === 0) {
    return { success: false, error: "No transferable inventory items found" };
  }

  const shopifyResult = await adjustShopifyInventory(admin, changes);
  if (!shopifyResult.success) return shopifyResult;

  const idempotencyKey = `transfer-send-${transferId}`;
  const levelUpdates: LocalLevelUpdate[] = transfer.lines.map((line) => ({
    variantId: line.variantId,
    locationId: transfer.sourceLocationId,
    delta: -line.quantity,
  }));
  const events: LocalEvent[] = transfer.lines.map((line) => ({
    idempotencyKey: `${idempotencyKey}-${line.id}`,
    variantId: line.variantId,
    locationId: transfer.sourceLocationId,
    quantityDelta: -line.quantity,
  }));

  await applyLocalInventoryUpdates(shopId, transferId, levelUpdates, events);

  await prisma.stockTransfer.update({
    where: { id: transferId },
    data: { status: "IN_TRANSIT", sentAt: new Date() },
  });

  return {
    success: true,
    unitsMoved: units,
    message: `Sent ${units} unit${units === 1 ? "" : "s"} from ${transfer.sourceLocation.name}. Shopify inventory at the source location has been reduced.`,
  };
}

export async function receiveTransfer(
  admin: AdminApiContext,
  shopId: string,
  transferId: string
): Promise<TransferActionResult> {
  const transfer = await prisma.stockTransfer.findFirst({
    where: { id: transferId, shopId },
    include: {
      destLocation: true,
      lines: { include: { variant: true } },
    },
  });
  if (!transfer || transfer.status !== "IN_TRANSIT") {
    return { success: false, error: "Transfer not found or not in transit" };
  }

  const destGid = `gid://shopify/Location/${transfer.destLocation.shopifyLocationId}`;
  const { changes, missingVariants, units } = buildChangesForLines(
    transfer.lines,
    destGid,
    1
  );

  if (missingVariants.length > 0) {
    return {
      success: false,
      error: `These variants are missing Shopify inventory items: ${missingVariants.join(", ")}`,
    };
  }

  if (changes.length > 0) {
    const shopifyResult = await adjustShopifyInventory(admin, changes);
    if (!shopifyResult.success) return shopifyResult;

    const idempotencyKey = `transfer-receive-${transferId}`;
    const levelUpdates: LocalLevelUpdate[] = transfer.lines.map((line) => ({
      variantId: line.variantId,
      locationId: transfer.destLocationId,
      delta: line.quantity,
    }));
    const events: LocalEvent[] = transfer.lines.map((line) => ({
      idempotencyKey: `${idempotencyKey}-${line.id}`,
      variantId: line.variantId,
      locationId: transfer.destLocationId,
      quantityDelta: line.quantity,
    }));

    await applyLocalInventoryUpdates(shopId, transferId, levelUpdates, events);
  }

  await prisma.stockTransfer.update({
    where: { id: transferId },
    data: { status: "RECEIVED", receivedAt: new Date() },
  });

  return {
    success: true,
    unitsMoved: units,
    message: `Received ${units} unit${units === 1 ? "" : "s"} at ${transfer.destLocation.name}. Shopify inventory at the destination has been increased.`,
  };
}

export async function cancelTransfer(
  admin: AdminApiContext,
  shopId: string,
  transferId: string
): Promise<TransferActionResult> {
  const transfer = await prisma.stockTransfer.findFirst({
    where: { id: transferId, shopId },
    include: {
      sourceLocation: true,
      destLocation: true,
      lines: { include: { variant: true } },
    },
  });
  if (!transfer) return { success: false, error: "Transfer not found" };
  if (transfer.deletedAt) return { success: false, error: "Transfer is already deleted" };

  const label = formatTransferDisplayNumber(transfer.transferNumber);
  const totalUnits = transfer.lines.reduce((sum, l) => sum + l.quantity, 0);
  const inventoryWasReceived = !!transfer.receivedAt;
  const inventoryWasSent = !!transfer.sentAt;

  if (!inventoryWasSent && !inventoryWasReceived) {
    await prisma.stockTransfer.update({
      where: { id: transferId },
      data: { deletedAt: new Date() },
    });
    return {
      success: true,
      inventoryReversed: false,
      message: `${label} moved to Deleted. No inventory was moved in Shopify.`,
    };
  }

  const changes: InventoryChange[] = [];
  const levelUpdates: LocalLevelUpdate[] = [];
  const events: LocalEvent[] = [];
  const missingVariants: string[] = [];

  if (!inventoryWasReceived) {
    const sourceGid = `gid://shopify/Location/${transfer.sourceLocation.shopifyLocationId}`;
    for (const line of transfer.lines) {
      const invItemId = line.variant.shopifyInventoryItemId;
      if (!invItemId) {
        missingVariants.push(line.variant.title);
        continue;
      }
      changes.push({
        inventoryItemId: `gid://shopify/InventoryItem/${invItemId}`,
        locationId: sourceGid,
        delta: line.quantity,
      });
      levelUpdates.push({
        variantId: line.variantId,
        locationId: transfer.sourceLocationId,
        delta: line.quantity,
      });
      events.push({
        idempotencyKey: `transfer-cancel-${transferId}-${line.id}-source`,
        variantId: line.variantId,
        locationId: transfer.sourceLocationId,
        quantityDelta: line.quantity,
      });
    }
  } else {
    const sourceGid = `gid://shopify/Location/${transfer.sourceLocation.shopifyLocationId}`;
    const destGid = `gid://shopify/Location/${transfer.destLocation.shopifyLocationId}`;
    for (const line of transfer.lines) {
      const invItemId = line.variant.shopifyInventoryItemId;
      if (!invItemId) {
        missingVariants.push(line.variant.title);
        continue;
      }
      changes.push(
        {
          inventoryItemId: `gid://shopify/InventoryItem/${invItemId}`,
          locationId: destGid,
          delta: -line.quantity,
        },
        {
          inventoryItemId: `gid://shopify/InventoryItem/${invItemId}`,
          locationId: sourceGid,
          delta: line.quantity,
        }
      );
      levelUpdates.push(
        {
          variantId: line.variantId,
          locationId: transfer.destLocationId,
          delta: -line.quantity,
        },
        {
          variantId: line.variantId,
          locationId: transfer.sourceLocationId,
          delta: line.quantity,
        }
      );
      events.push(
        {
          idempotencyKey: `transfer-cancel-${transferId}-${line.id}-dest`,
          variantId: line.variantId,
          locationId: transfer.destLocationId,
          quantityDelta: -line.quantity,
        },
        {
          idempotencyKey: `transfer-cancel-${transferId}-${line.id}-source`,
          variantId: line.variantId,
          locationId: transfer.sourceLocationId,
          quantityDelta: line.quantity,
        }
      );
    }
  }

  if (missingVariants.length > 0) {
    return {
      success: false,
      error: `Cannot reverse inventory — missing Shopify inventory items for: ${missingVariants.join(", ")}`,
    };
  }

  if (changes.length > 0) {
    const shopifyResult = await adjustShopifyInventory(admin, changes);
    if (!shopifyResult.success) return shopifyResult;
    await applyLocalInventoryUpdates(shopId, transferId, levelUpdates, events);
  }

  await prisma.stockTransfer.update({
    where: { id: transferId },
    data: { deletedAt: new Date() },
  });

  if (!inventoryWasReceived) {
    return {
      success: true,
      inventoryReversed: true,
      unitsMoved: totalUnits,
      message: `${label} moved to Deleted. Returned ${totalUnits} unit${totalUnits === 1 ? "" : "s"} to ${transfer.sourceLocation.name} in Shopify.`,
    };
  }

  return {
    success: true,
    inventoryReversed: true,
    unitsMoved: totalUnits,
    message: `${label} moved to Deleted. Reversed the transfer in Shopify: removed ${totalUnits} unit${totalUnits === 1 ? "" : "s"} from ${transfer.destLocation.name} and restored them to ${transfer.sourceLocation.name}.`,
  };
}

/** Alias for delete from list/detail routes */
export const deleteTransfer = cancelTransfer;

export async function restoreTransfer(
  admin: AdminApiContext,
  shopId: string,
  transferId: string
): Promise<TransferActionResult> {
  const transfer = await prisma.stockTransfer.findFirst({
    where: { id: transferId, shopId, deletedAt: { not: null } },
    include: {
      sourceLocation: true,
      destLocation: true,
      lines: { include: { variant: true } },
    },
  });
  if (!transfer) return { success: false, error: "Deleted transfer not found" };

  const label = formatTransferDisplayNumber(transfer.transferNumber);
  const totalUnits = transfer.lines.reduce((sum, l) => sum + l.quantity, 0);

  const inventoryWasReceived = !!transfer.receivedAt;
  const inventoryWasSent = !!transfer.sentAt;

  if (!inventoryWasSent && !inventoryWasReceived) {
    await prisma.stockTransfer.update({
      where: { id: transferId },
      data: { deletedAt: null },
    });
    return {
      success: true,
      message: `${label} restored to the main transfers list.`,
    };
  }

  const changes: InventoryChange[] = [];
  const levelUpdates: LocalLevelUpdate[] = [];
  const events: LocalEvent[] = [];
  const missingVariants: string[] = [];
  const sourceGid = `gid://shopify/Location/${transfer.sourceLocation.shopifyLocationId}`;
  const destGid = `gid://shopify/Location/${transfer.destLocation.shopifyLocationId}`;

  if (!inventoryWasReceived) {
    for (const line of transfer.lines) {
      const invItemId = line.variant.shopifyInventoryItemId;
      if (!invItemId) {
        missingVariants.push(line.variant.title);
        continue;
      }
      changes.push({
        inventoryItemId: `gid://shopify/InventoryItem/${invItemId}`,
        locationId: sourceGid,
        delta: -line.quantity,
      });
      levelUpdates.push({
        variantId: line.variantId,
        locationId: transfer.sourceLocationId,
        delta: -line.quantity,
      });
      events.push({
        idempotencyKey: `transfer-restore-${transferId}-${line.id}-source`,
        variantId: line.variantId,
        locationId: transfer.sourceLocationId,
        quantityDelta: -line.quantity,
      });
    }
  } else {
    for (const line of transfer.lines) {
      const invItemId = line.variant.shopifyInventoryItemId;
      if (!invItemId) {
        missingVariants.push(line.variant.title);
        continue;
      }
      changes.push(
        {
          inventoryItemId: `gid://shopify/InventoryItem/${invItemId}`,
          locationId: sourceGid,
          delta: -line.quantity,
        },
        {
          inventoryItemId: `gid://shopify/InventoryItem/${invItemId}`,
          locationId: destGid,
          delta: line.quantity,
        }
      );
      levelUpdates.push(
        {
          variantId: line.variantId,
          locationId: transfer.sourceLocationId,
          delta: -line.quantity,
        },
        {
          variantId: line.variantId,
          locationId: transfer.destLocationId,
          delta: line.quantity,
        }
      );
      events.push(
        {
          idempotencyKey: `transfer-restore-${transferId}-${line.id}-source`,
          variantId: line.variantId,
          locationId: transfer.sourceLocationId,
          quantityDelta: -line.quantity,
        },
        {
          idempotencyKey: `transfer-restore-${transferId}-${line.id}-dest`,
          variantId: line.variantId,
          locationId: transfer.destLocationId,
          quantityDelta: line.quantity,
        }
      );
    }
  }

  if (missingVariants.length > 0) {
    return {
      success: false,
      error: `Cannot restore inventory — missing Shopify inventory items for: ${missingVariants.join(", ")}`,
    };
  }

  if (changes.length > 0) {
    const shopifyResult = await adjustShopifyInventory(admin, changes);
    if (!shopifyResult.success) return shopifyResult;
    await applyLocalInventoryUpdates(shopId, transferId, levelUpdates, events);
  }

  await prisma.stockTransfer.update({
    where: { id: transferId },
    data: { deletedAt: null },
  });

  if (!inventoryWasReceived) {
    return {
      success: true,
      inventoryReversed: true,
      unitsMoved: totalUnits,
      message: `${label} restored. Deducted ${totalUnits} unit${totalUnits === 1 ? "" : "s"} from ${transfer.sourceLocation.name} in Shopify.`,
    };
  }

  return {
    success: true,
    inventoryReversed: true,
    unitsMoved: totalUnits,
    message: `${label} restored. Re-applied the transfer in Shopify (${totalUnits} unit${totalUnits === 1 ? "" : "s"} from ${transfer.sourceLocation.name} to ${transfer.destLocation.name}).`,
  };
}
