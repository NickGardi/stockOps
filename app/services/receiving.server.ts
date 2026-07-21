/**
 * Idempotent receiving: update Shopify inventory and track received qty.
 * Reconcile: update PO receivedQty only (no Shopify sync) - for when user already updated Shopify.
 * reverseReceivedInventory: subtract received quantities from Shopify when deleting a received PO.
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { graphqlWithRetry } from "../lib/shopify-graphql.server";
import { ensureInventoryActivatedAtLocation, ensureInventoryItemsActivatedAtLocation } from "../lib/inventory-activate.server";
import { logger } from "../lib/logger.server";

export async function receiveLine(
  admin: AdminApiContext,
  shopId: string,
  purchaseOrderLineId: string,
  variantId: string,
  locationId: string,
  quantity: number,
  idempotencyKey: string,
  options: { allowOverreceive?: boolean } = {}
): Promise<{ success: boolean; error?: string }> {
  const line = await prisma.purchaseOrderLine.findUnique({
    where: { id: purchaseOrderLineId },
    include: { purchaseOrder: true },
  });
  if (!line || line.purchaseOrder.shopId !== shopId) {
    return { success: false, error: "Line not found" };
  }

  const maxReceive = line.orderedQty - line.receivedQty;
  if (!options.allowOverreceive && quantity > maxReceive) {
    return { success: false, error: `Cannot receive more than ${maxReceive} (ordered: ${line.orderedQty}, already received: ${line.receivedQty})` };
  }

  const existing = await prisma.inventoryEvent.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    return { success: true };
  }

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { primaryWarehouseLocationId: true },
  });
  const effectiveLocationId = line.purchaseOrder.receivingLocationId ?? shop?.primaryWarehouseLocationId;
  if (!effectiveLocationId) {
    return { success: false, error: "Receiving location not set. Select a location for this PO or in Settings." };
  }
  if (locationId !== effectiveLocationId) {
    return { success: false, error: "Receiving must be into the PO's receiving location." };
  }

  const variant = await prisma.variant.findUnique({
    where: { id: variantId },
    include: { product: true },
  });
  const location = await prisma.location.findUnique({
    where: { id: locationId },
  });
  if (!variant || !location || variant.shopId !== shopId || location.shopId !== shopId) {
    return { success: false, error: "Variant or location not found" };
  }

  const inventoryItemId = variant.shopifyInventoryItemId;
  if (!inventoryItemId) {
    return { success: false, error: "Variant has no inventory item" };
  }

  const invItemGid = `gid://shopify/InventoryItem/${inventoryItemId}`;
  const locGid = `gid://shopify/Location/${location.shopifyLocationId}`;

  const activated = await ensureInventoryActivatedAtLocation(
    admin as Parameters<typeof ensureInventoryActivatedAtLocation>[0],
    invItemGid,
    locGid
  );
  if (!activated.success) {
    return {
      success: false,
      error: activated.error ?? "Could not enable this product at the receiving location in Shopify.",
    };
  }

  const mutation = `#graphql
    mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        inventoryAdjustmentGroup {
          createdAt
        }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    input: {
      name: "available",
      reason: "restock",
      changes: [
        {
          inventoryItemId: invItemGid,
          locationId: locGid,
          delta: quantity,
        },
      ],
    },
  };

  try {
    const { data } = await graphqlWithRetry<{
      inventoryAdjustQuantities?: {
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(admin as Parameters<typeof graphqlWithRetry>[0], mutation, { variables });

    const errors = data?.inventoryAdjustQuantities?.userErrors ?? [];
    if (errors.length > 0) {
      return { success: false, error: errors.map((e) => e.message).join("; ") };
    }

    await prisma.$transaction([
      prisma.inventoryEvent.create({
        data: {
          shopId,
          idempotencyKey,
          variantId,
          locationId,
          quantityDelta: quantity,
          source: "RECEIVING",
          referenceId: purchaseOrderLineId,
        },
      }),
      prisma.purchaseOrderLine.update({
        where: { id: purchaseOrderLineId },
        data: { receivedQty: { increment: quantity }, updatedAt: new Date() },
      }),
      prisma.inventoryLevel.upsert({
        where: { variantId_locationId: { variantId, locationId } },
        create: { shopId, variantId, locationId, available: quantity },
        update: { available: { increment: quantity }, updatedAt: new Date() },
      }),
    ]);

    const po = line.purchaseOrder;
    const allLines = await prisma.purchaseOrderLine.findMany({
      where: { purchaseOrderId: po.id },
    });
    const allReceived = allLines.every((l) => l.receivedQty >= l.orderedQty);
    const anyReceived = allLines.some((l) => l.receivedQty > 0);
    const newStatus = allReceived ? "RECEIVED" : anyReceived ? "PARTIALLY_RECEIVED" : po.status;
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { status: newStatus, updatedAt: new Date() },
    });

    return { success: true };
  } catch (err) {
    logger.error("Receive failed", {
      purchaseOrderLineId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export type BatchLineUpdate = { lineId: string; quantity: number };

export async function receiveBatch(
  admin: AdminApiContext,
  shopId: string,
  poId: string,
  lineUpdates: BatchLineUpdate[],
  idempotencyKeyPrefix: string,
  options: { allowOverreceive?: boolean } = {}
): Promise<{ success: boolean; received: number; error?: string }> {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, shopId },
    include: {
      lines: { include: { variant: true } },
    },
  });
  if (!po) {
    return { success: false, received: 0, error: "PO not found" };
  }
  if (po.deletedAt) {
    return { success: false, received: 0, error: "Cannot receive a deleted purchase order" };
  }

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { primaryWarehouseLocationId: true },
  });
  const locationId = po.receivingLocationId ?? shop?.primaryWarehouseLocationId;
  if (!locationId) {
    return { success: false, received: 0, error: "Receiving location not set." };
  }

  const location = await prisma.location.findUnique({
    where: { id: locationId },
  });
  if (!location || location.shopId !== shopId) {
    return { success: false, received: 0, error: "Location not found" };
  }
  const locGid = `gid://shopify/Location/${location.shopifyLocationId}`;

  const lineMap = new Map(po.lines.map((l) => [l.id, l]));
  const changes: Array<{ inventoryItemId: string; locationId: string; delta: number }> = [];
  const toProcess: Array<{ lineId: string; quantity: number }> = [];
  let skipped = 0;

  for (const u of lineUpdates) {
    if (u.quantity <= 0) continue;
    const line = lineMap.get(u.lineId);
    if (!line || line.purchaseOrderId !== poId) continue;

    const maxReceive = line.orderedQty - line.receivedQty;
    if (!options.allowOverreceive && u.quantity > maxReceive) continue;

    const idempotencyKey = `${idempotencyKeyPrefix}-${u.lineId}`;
    const existing = await prisma.inventoryEvent.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      skipped++;
      continue;
    }

    const invItemId = line.variant.shopifyInventoryItemId;
    if (!invItemId) continue;

    changes.push({
      inventoryItemId: `gid://shopify/InventoryItem/${invItemId}`,
      locationId: locGid,
      delta: u.quantity,
    });
    toProcess.push({ lineId: u.lineId, quantity: u.quantity });
  }

  if (changes.length === 0) {
    return { success: true, received: skipped };
  }

  const activated = await ensureInventoryItemsActivatedAtLocation(
    admin as Parameters<typeof ensureInventoryItemsActivatedAtLocation>[0],
    changes.map((c) => c.inventoryItemId),
    locGid
  );
  if (!activated.success) {
    return {
      success: false,
      received: 0,
      error: activated.error ?? "Could not enable products at the receiving location in Shopify.",
    };
  }

  const mutation = `#graphql
    mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        inventoryAdjustmentGroup {
          createdAt
        }
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
      variables: { input: { name: "available", reason: "restock", changes } },
    });

    const errors = data?.inventoryAdjustQuantities?.userErrors ?? [];
    if (errors.length > 0) {
      return {
        success: false,
        received: 0,
        error: errors.map((e) => e.message).join("; "),
      };
    }

    await prisma.$transaction(
      toProcess.flatMap((p) => [
        prisma.inventoryEvent.create({
          data: {
            shopId,
            idempotencyKey: `${idempotencyKeyPrefix}-${p.lineId}`,
            variantId: lineMap.get(p.lineId)!.variantId,
            locationId,
            quantityDelta: p.quantity,
            source: "RECEIVING",
            referenceId: p.lineId,
          },
        }),
        prisma.purchaseOrderLine.update({
          where: { id: p.lineId },
          data: { receivedQty: { increment: p.quantity }, updatedAt: new Date() },
        }),
        prisma.inventoryLevel.upsert({
          where: {
            variantId_locationId: {
              variantId: lineMap.get(p.lineId)!.variantId,
              locationId,
            },
          },
          create: {
            shopId,
            variantId: lineMap.get(p.lineId)!.variantId,
            locationId,
            available: p.quantity,
          },
          update: {
            available: { increment: p.quantity },
            updatedAt: new Date(),
          },
        }),
      ])
    );

    const allLines = await prisma.purchaseOrderLine.findMany({
      where: { purchaseOrderId: po.id },
    });
    const allReceived = allLines.every((l) => l.receivedQty >= l.orderedQty);
    const anyReceived = allLines.some((l) => l.receivedQty > 0);
    const newStatus = allReceived ? "RECEIVED" : anyReceived ? "PARTIALLY_RECEIVED" : po.status;
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { status: newStatus, updatedAt: new Date() },
    });

    return { success: true, received: toProcess.length + skipped };
  } catch (err) {
    logger.error("Receive batch failed", {
      poId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      success: false,
      received: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Restore inventory changes when undeleting a RECEIVED PO.
 * Call when restoring from deleted to add back received quantities to Shopify.
 */
export async function restoreReceivedInventory(
  admin: AdminApiContext,
  shopId: string,
  poId: string
): Promise<{ success: boolean; error?: string }> {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, shopId },
    include: {
      lines: { include: { variant: true } },
      receivingLocation: true,
    },
  });
  if (!po) return { success: false, error: "PO not found" };

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { primaryWarehouseLocationId: true },
  });
  const locationId = po.receivingLocationId ?? shop?.primaryWarehouseLocationId;
  if (!locationId) return { success: false, error: "Receiving location not set" };

  const location = po.receivingLocation ?? (await prisma.location.findUnique({ where: { id: locationId } }));
  if (!location || location.shopId !== shopId) return { success: false, error: "Location not found" };

  const locGid = `gid://shopify/Location/${location.shopifyLocationId}`;
  const changes: Array<{ inventoryItemId: string; locationId: string; delta: number }> = [];

  for (const line of po.lines) {
    if (line.receivedQty <= 0) continue;
    const invItemId = line.variant?.shopifyInventoryItemId;
    if (!invItemId) continue;

    changes.push({
      inventoryItemId: `gid://shopify/InventoryItem/${invItemId}`,
      locationId: locGid,
      delta: line.receivedQty,
    });
  }

  if (changes.length === 0) return { success: true };

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
      variables: { input: { name: "available", reason: "restock", changes } },
    });

    const errors = data?.inventoryAdjustQuantities?.userErrors ?? [];
    if (errors.length > 0) {
      return { success: false, error: errors.map((e) => e.message).join("; ") };
    }
    return { success: true };
  } catch (err) {
    logger.error("Restore received inventory failed", {
      poId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Reverse inventory changes made by receiving a PO.
 * Call before deleting a RECEIVED PO to subtract received quantities from Shopify.
 */
export async function reverseReceivedInventory(
  admin: AdminApiContext,
  shopId: string,
  poId: string
): Promise<{ success: boolean; error?: string }> {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, shopId },
    include: {
      lines: { include: { variant: true } },
      receivingLocation: true,
    },
  });
  if (!po) return { success: false, error: "PO not found" };

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { primaryWarehouseLocationId: true },
  });
  const locationId = po.receivingLocationId ?? shop?.primaryWarehouseLocationId;
  if (!locationId) return { success: false, error: "Receiving location not set" };

  const location = po.receivingLocation ?? (await prisma.location.findUnique({ where: { id: locationId } }));
  if (!location || location.shopId !== shopId) return { success: false, error: "Location not found" };

  const locGid = `gid://shopify/Location/${location.shopifyLocationId}`;
  const changes: Array<{ inventoryItemId: string; locationId: string; delta: number }> = [];

  for (const line of po.lines) {
    if (line.receivedQty <= 0) continue;
    const invItemId = line.variant?.shopifyInventoryItemId;
    if (!invItemId) continue;

    changes.push({
      inventoryItemId: `gid://shopify/InventoryItem/${invItemId}`,
      locationId: locGid,
      delta: -line.receivedQty,
    });
  }

  if (changes.length === 0) return { success: true };

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
      variables: { input: { name: "available", reason: "correction", changes } },
    });

    const errors = data?.inventoryAdjustQuantities?.userErrors ?? [];
    if (errors.length > 0) {
      return { success: false, error: errors.map((e) => e.message).join("; ") };
    }
    return { success: true };
  } catch (err) {
    logger.error("Reverse received inventory failed", {
      poId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Reconcile: update PO receivedQty only, no Shopify sync.
 * Use when user already updated stock in Shopify and just needs to fix PO tracking.
 */
export async function reconcileReceivedQty(
  shopId: string,
  poId: string,
  lineUpdates: Array<{ lineId: string; receivedQty: number }>
): Promise<{ success: boolean; error?: string }> {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, shopId },
    include: { lines: true },
  });
  if (!po) return { success: false, error: "PO not found" };
  if (po.deletedAt) return { success: false, error: "Cannot reconcile a deleted purchase order" };
  if (!["ORDERED", "PARTIALLY_RECEIVED", "RECEIVED"].includes(po.status)) {
    return { success: false, error: "Can only reconcile ORDERED, PARTIALLY_RECEIVED, or RECEIVED POs" };
  }

  const lineMap = new Map(po.lines.map((l) => [l.id, l]));
  for (const u of lineUpdates) {
    const line = lineMap.get(u.lineId);
    if (!line || line.purchaseOrderId !== poId) continue;
    const receivedQty = Math.max(0, Math.min(u.receivedQty, line.orderedQty));
    await prisma.purchaseOrderLine.update({
      where: { id: u.lineId },
      data: { receivedQty, updatedAt: new Date() },
    });
  }

  const allLines = await prisma.purchaseOrderLine.findMany({
    where: { purchaseOrderId: po.id },
  });
  const allReceived = allLines.every((l) => l.receivedQty >= l.orderedQty);
  const anyReceived = allLines.some((l) => l.receivedQty > 0);
  const newStatus = allReceived ? "RECEIVED" : anyReceived ? "PARTIALLY_RECEIVED" : po.status;
  await prisma.purchaseOrder.update({
    where: { id: po.id },
    data: { status: newStatus, updatedAt: new Date() },
  });

  return { success: true };
}

/**
 * Sync received quantities from Shopify inventory.
 * Fetches current inventory at the receiving location and sets receivedQty = min(orderedQty, available).
 * Use when stock was updated manually in Shopify and you want to catch up PO tracking.
 */
export async function syncReceivedFromShopify(
  admin: Parameters<typeof graphqlWithRetry>[0],
  shopId: string,
  poId: string
): Promise<{ success: boolean; updated: number; error?: string }> {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, shopId },
    include: {
      lines: { include: { variant: true } },
      receivingLocation: true,
    },
  });
  if (!po) return { success: false, updated: 0, error: "PO not found" };
  if (po.deletedAt) return { success: false, updated: 0, error: "Cannot sync a deleted purchase order" };
  if (!["ORDERED", "PARTIALLY_RECEIVED"].includes(po.status)) {
    return { success: false, updated: 0, error: "Can only sync ORDERED or PARTIALLY_RECEIVED POs" };
  }

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { primaryWarehouseLocationId: true },
  });
  const locationId = po.receivingLocationId ?? shop?.primaryWarehouseLocationId;
  if (!locationId) {
    return { success: false, updated: 0, error: "Receiving location not set" };
  }

  const location = await prisma.location.findUnique({
    where: { id: locationId },
  });
  if (!location || location.shopId !== shopId) {
    return { success: false, updated: 0, error: "Location not found" };
  }

  const linesWithInv = po.lines.filter((l) => l.variant?.shopifyInventoryItemId);
  if (linesWithInv.length === 0) {
    return { success: true, updated: 0 };
  }

  const ids = linesWithInv.map(
    (l) => `gid://shopify/InventoryItem/${l.variant!.shopifyInventoryItemId}`
  );

  const query = `#graphql
    query InventoryLevelsBatch($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on InventoryItem {
          id
          inventoryLevels(first: 50) {
            edges {
              node {
                location { id }
                quantities(names: ["available"]) { quantity }
              }
            }
          }
        }
      }
    }
  `;

  type NodeResult = {
    id: string;
    inventoryLevels?: {
      edges: Array<{
        node: {
          location: { id: string };
          quantities: Array<{ quantity: number }>;
        };
      }>;
    };
  };

  const { data } = await graphqlWithRetry<{ nodes: NodeResult[] }>(
    admin,
    query,
    { variables: { ids } }
  );

  const locGid = `gid://shopify/Location/${location.shopifyLocationId}`;
  const invItemToAvailable = new Map<string, number>();

  for (const node of data?.nodes ?? []) {
    if (!node || typeof node !== "object" || !("inventoryLevels" in node)) continue;
    const levels = node.inventoryLevels?.edges ?? [];
    for (const edge of levels) {
      const n = edge.node;
      if (n.location?.id === locGid) {
        const qty = n.quantities?.[0]?.quantity ?? 0;
        invItemToAvailable.set(node.id, qty);
        break;
      }
    }
  }

  let updated = 0;

  for (const line of linesWithInv) {
    const invItemId = line.variant!.shopifyInventoryItemId;
    const gid = `gid://shopify/InventoryItem/${invItemId}`;
    const available = invItemToAvailable.get(gid) ?? 0;
    const newReceived = Math.max(0, Math.min(line.orderedQty, available));
    if (newReceived !== line.receivedQty) {
      await prisma.purchaseOrderLine.update({
        where: { id: line.id },
        data: { receivedQty: newReceived, updatedAt: new Date() },
      });
      updated++;
    }
  }

  const allLines = await prisma.purchaseOrderLine.findMany({
    where: { purchaseOrderId: po.id },
  });
  const allReceived = allLines.every((l) => l.receivedQty >= l.orderedQty);
  const anyReceived = allLines.some((l) => l.receivedQty > 0);
  const newStatus = allReceived ? "RECEIVED" : anyReceived ? "PARTIALLY_RECEIVED" : po.status;
  await prisma.purchaseOrder.update({
    where: { id: po.id },
    data: { status: newStatus, updatedAt: new Date() },
  });

  return { success: true, updated };
}
