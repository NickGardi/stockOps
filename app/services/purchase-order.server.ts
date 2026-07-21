/**
 * Purchase order helpers: add line from reorder, find-or-create draft.
 */

import prisma from "../db.server";
import { formatPoDisplayNumber } from "../lib/format-po";

export { formatPoDisplayNumber };

export async function getNextPoNumber(shopId: string): Promise<number> {
  const max = await prisma.purchaseOrder.findFirst({
    where: { shopId },
    orderBy: { poNumber: "desc" },
    select: { poNumber: true },
  });
  return (max?.poNumber ?? 0) + 1;
}

/** Backfill poNumber for existing POs that have 0 (one-time migration) */
export async function backfillPoNumbers(shopId: string): Promise<void> {
  const needBackfill = await prisma.purchaseOrder.findMany({
    where: { shopId, poNumber: 0 },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (needBackfill.length === 0) return;
  const max = await prisma.purchaseOrder.findFirst({
    where: { shopId, poNumber: { gt: 0 } },
    orderBy: { poNumber: "desc" },
    select: { poNumber: true },
  });
  let next = (max?.poNumber ?? 0) + 1;
  for (const po of needBackfill) {
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { poNumber: next++ },
    });
  }
}
import { hasCompleteSupplierDetails } from "./supplier-assignment.server";
import { getOnOrderByVariant } from "./reorder.server";

export type POVariantOption = {
  id: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  onHand: number;
  onOrder: number;
  unitCost: string | null;
};

export async function getSupplierVariantOptionsForPO(
  shopId: string,
  supplierId: string,
  locationId: string
): Promise<POVariantOption[]> {
  const onOrderByVariant = await getOnOrderByVariant(shopId);
  const variants = await prisma.variant.findMany({
    where: {
      shopId,
      inventoryTracked: true,
      variantSuppliers: { some: { supplierId } },
    },
    include: {
      product: true,
      variantSuppliers: { where: { supplierId }, take: 1 },
      inventoryLevels: { where: { locationId }, take: 1 },
    },
    orderBy: [{ product: { title: "asc" } }, { title: "asc" }],
    take: 500,
  });

  return variants.map((v) => {
    const vs = v.variantSuppliers[0];
    return {
      id: v.id,
      productTitle: v.product.title,
      variantTitle: v.title,
      sku: v.sku,
      onHand: v.inventoryLevels[0]?.available ?? 0,
      onOrder: onOrderByVariant.get(v.id) ?? 0,
      unitCost: vs?.cost ?? null,
    };
  });
}

export async function addReorderLineToPO(
  shopId: string,
  variantId: string,
  quantity: number
): Promise<{ success: boolean; poId?: string; error?: string }> {
  const variant = await prisma.variant.findFirst({
    where: { id: variantId, shopId },
    include: {
      product: true,
      variantSuppliers: { include: { supplier: true }, take: 1 },
    },
  });
  if (!variant) return { success: false, error: "Variant not found" };

  const vs = variant.variantSuppliers[0];
  if (!vs) return { success: false, error: "Supplier required. Assign a supplier first." };
  if (!hasCompleteSupplierDetails({ cost: vs.cost, leadTimeDays: vs.leadTimeDays })) {
    return { success: false, error: "Details required. Add cost and lead time for this variant." };
  }

  if (quantity < 1) return { success: false, error: "Quantity must be at least 1" };

  let po = await prisma.purchaseOrder.findFirst({
    where: { shopId, supplierId: vs.supplierId, status: "DRAFT", deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!po) {
    const poNumber = await getNextPoNumber(shopId);
    po = await prisma.purchaseOrder.create({
      data: { shopId, supplierId: vs.supplierId, status: "DRAFT", poNumber },
    });
  }

  await prisma.purchaseOrderLine.upsert({
    where: {
      purchaseOrderId_variantId: { purchaseOrderId: po.id, variantId: variant.id },
    },
    create: {
      purchaseOrderId: po.id,
      variantId: variant.id,
      orderedQty: quantity,
      unitCost: vs.cost,
    },
    update: {
      orderedQty: { increment: quantity },
      unitCost: vs.cost,
    },
  });

  return { success: true, poId: po.id };
}
