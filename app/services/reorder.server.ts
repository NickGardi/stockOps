/**
 * Reorder suggestion math (v1).
 * suggested = max(0, ceil(demand_during_lead + safety_stock - on_hand - on_order))
 * target = demand_during_lead + safety_stock
 * Excludes: gift cards, untracked inventory, draft/archived products, soft-deleted.
 * Window: 60 days (configurable).
 */

import prisma from "../db.server";
import { getVelocity, getVelocityYoY } from "./sales-velocity.server";
import { hasCompleteSupplierDetails } from "./supplier-assignment.server";

export type VelocityMode = "last30" | "last60" | "yoy" | "fillToTarget";

export type ReorderRow = {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  supplierName: string | null;
  supplierId: string | null;
  variantSupplierId: string | null;
  minStock: number | null;
  maxStock: number | null;
  minOrderQty: number | null;
  detailsComplete: boolean; // has valid cost and leadTimeDays
  locationName: string;
  locationId: string;
  onHand: number;
  totalStock?: number; // optional: total across all locations
  onOrder: number;
  avgDailySales: number;
  leadTimeDays: number;
  safetyDays: number;
  suggestedQty: number;
  daysOfCover: number | null; // (onHand+onOrder)/avgDailySales, null when avg=0
  retailPrice: string; // variant.price
  unitCost: string | null; // from variant_supplier
  marginPct: number | null; // (retail - cost) / retail * 100 when both valid
};

export async function getReorderSuggestions(
  shopId: string,
  options: {
    supplierIds?: string[];
    lowStockOnly?: boolean;
    search?: string;
    windowDays?: number;
    velocityMode?: VelocityMode;
    includeTotalStock?: boolean;
  } = {}
): Promise<ReorderRow[]> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { primaryWarehouseLocation: true },
  });
  if (!shop?.primaryWarehouseLocationId) return [];
  if (!shop.primaryWarehouseLocation || !shop.primaryWarehouseLocation.isActive) return []; // deleted/inactive warehouse

  const settings = await prisma.shopSetting.findUnique({
    where: { shopId },
  });
  const defaultLeadTime = settings?.defaultLeadTimeDays ?? 7;
  const defaultSafety = settings?.defaultSafetyDays ?? 3;
  const velocityMode = options.velocityMode ?? "last60";
  const windowDays = options.windowDays ?? (velocityMode === "last30" ? 30 : 60);

  const variants = await prisma.variant.findMany({
    where: {
      shopId,
      inventoryTracked: true,
      product: {
        deletedAt: null,
        status: { notIn: ["DRAFT", "ARCHIVED"] },
        OR: [{ productType: null }, { productType: { not: "Gift Card" } }],
      },
      ...(options.supplierIds && options.supplierIds.length > 0
        ? { variantSuppliers: { some: { supplierId: { in: options.supplierIds } } } }
        : {}),
      ...(options.search
        ? {
            OR: [
              { sku: { contains: options.search } },
              { title: { contains: options.search } },
              { product: { title: { contains: options.search } } },
            ],
          }
        : {}),
    },
    include: {
      product: true,
      inventoryLevels: {
        include: { location: true },
      },
      variantSuppliers: {
        include: { supplier: true },
        take: 1,
      },
    },
  });

  const onOrderByVariant = await getOnOrderByVariant(shopId);

  const rows: ReorderRow[] = [];

  const primaryLocId = shop.primaryWarehouseLocationId;

  for (const v of variants) {
    const warehouseLevel = v.inventoryLevels.find((il) => il.locationId === primaryLocId);
    if (!warehouseLevel) continue; // no inventory at primary warehouse

    const vs = v.variantSuppliers[0];
    const detailsComplete = vs ? hasCompleteSupplierDetails({ cost: vs.cost, leadTimeDays: vs.leadTimeDays }) : false;
    // Lead time cascade: variant_supplier → supplier.defaultLeadTimeDays → shop
    const leadTimeDays =
      vs?.leadTimeDays ??
      vs?.supplier?.defaultLeadTimeDays ??
      defaultLeadTime;
    const safetyDays = defaultSafety;

    const onHand = warehouseLevel.available;
    const onOrder = onOrderByVariant.get(v.id) ?? 0;

    const hasMinMax = vs?.minStock != null && vs?.maxStock != null && (vs.maxStock ?? 0) > 0;
    const hasMax = vs?.maxStock != null && (vs.maxStock ?? 0) > 0;

    let avgDailySales: number;
    let suggestedQty: number;

    if (velocityMode === "fillToTarget") {
      // Fill to target: order up to max. Requires min/max. Ignores velocity.
      avgDailySales = 0; // not used for suggested qty
      if (hasMinMax) {
        const target = vs!.maxStock!;
        const toOrder = Math.max(0, Math.ceil(target - onHand - onOrder));
        const minOrd = vs!.minOrderQty ?? 1;
        suggestedQty = toOrder > 0 ? Math.max(minOrd, toOrder) : 0;
      } else {
        suggestedQty = 0;
      }
    } else {
      // Velocity-based: last30, last60, or yoy
      avgDailySales =
        velocityMode === "yoy"
          ? await getVelocityYoY(v.id, windowDays)
          : await getVelocity(v.id, windowDays);

      if (avgDailySales === 0 || !detailsComplete) {
        suggestedQty = 0;
      } else {
        const velocityOrder = Math.max(
          0,
          Math.ceil(avgDailySales * leadTimeDays + avgDailySales * safetyDays - onHand - onOrder)
        );
        if (hasMax) {
          const roomToMax = Math.max(0, vs!.maxStock! - onHand - onOrder);
          const capped = Math.min(velocityOrder, roomToMax);
          const minOrd = vs!.minOrderQty ?? 1;
          suggestedQty = capped > 0 ? Math.min(Math.max(minOrd, Math.ceil(capped)), roomToMax) : 0;
        } else {
          suggestedQty = velocityOrder;
        }
      }
    }
    const daysOfCover =
      avgDailySales > 0 ? (onHand + onOrder) / avgDailySales : null;

    if (options.lowStockOnly && suggestedQty <= 0 && detailsComplete) continue; // hide complete rows with no reorder needed

    const totalStock = options.includeTotalStock
      ? v.inventoryLevels.reduce((sum, il) => sum + il.available, 0)
      : undefined;

    const retailPrice = v.price;
    const unitCost = vs?.cost ?? null;
    const retailNum = parseFloat(retailPrice);
    const costNum = unitCost != null ? parseFloat(unitCost) : NaN;
    const marginPct =
      !Number.isNaN(retailNum) && !Number.isNaN(costNum) && retailNum > 0
        ? ((retailNum - costNum) / retailNum) * 100
        : null;

    rows.push({
      variantId: v.id,
      productTitle: v.product.title,
      variantTitle: v.title,
      sku: v.sku,
      supplierName: vs?.supplier?.name ?? null,
      supplierId: vs?.supplierId ?? null,
      variantSupplierId: vs?.id ?? null,
      minStock: vs?.minStock ?? null,
      maxStock: vs?.maxStock ?? null,
      minOrderQty: vs?.minOrderQty ?? null,
      detailsComplete,
      locationName: warehouseLevel.location.name,
      locationId: warehouseLevel.location.id,
      onHand,
      ...(totalStock !== undefined && { totalStock }),
      onOrder,
      avgDailySales,
      leadTimeDays,
      safetyDays,
      suggestedQty,
      daysOfCover,
      retailPrice,
      unitCost,
      marginPct,
    });
  }

  // Sort: items recommended to reorder (suggestedQty > 0) at top, then by suggestedQty descending
  rows.sort((a, b) => {
    const aRecommended = a.detailsComplete && a.suggestedQty > 0;
    const bRecommended = b.detailsComplete && b.suggestedQty > 0;
    if (aRecommended && !bRecommended) return -1;
    if (!aRecommended && bRecommended) return 1;
    if (aRecommended && bRecommended) return b.suggestedQty - a.suggestedQty; // higher qty first
    return a.productTitle.localeCompare(b.productTitle); // stable sort for non-recommended
  });

  return rows;
}

export async function getOnOrderByVariant(shopId: string): Promise<Map<string, number>> {
  const openPos = await prisma.purchaseOrder.findMany({
    where: { shopId, deletedAt: null, status: { in: ["DRAFT", "ORDERED", "PARTIALLY_RECEIVED"] } },
    include: { lines: true },
  });

  const map = new Map<string, number>();
  for (const po of openPos) {
    if (po.status === "DRAFT") continue;
    for (const line of po.lines) {
      const pending = line.orderedQty - line.receivedQty;
      if (pending > 0) {
        map.set(line.variantId, (map.get(line.variantId) ?? 0) + pending);
      }
    }
  }
  return map;
}
