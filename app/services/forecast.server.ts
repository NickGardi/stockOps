/**
 * PO line generation from forecast/min-max.
 * Modes: SUGGESTION (velocity + min/max), FILL_SHELVES (min/max only), TARGET_STOCK (min/max target), BLANK (manual).
 */

import prisma from "../db.server";
import { getVelocity, getVelocityYoY, getVelocityForDateRange } from "./sales-velocity.server";
import { hasCompleteSupplierDetails } from "./supplier-assignment.server";

export type ForecastMode =
  | "SUGGESTION"
  | "FILL_SHELVES"
  | "FILL_SHELVES_IF_BELOW_MIN"
  | "TARGET_STOCK"
  | "YOY"
  | "CUSTOM"
  | "BLANK";

export type ForecastLine = {
  variantId: string;
  quantity: number;
  unitCost: string | null;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
};

async function getOnOrderByVariant(shopId: string): Promise<Map<string, number>> {
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

export async function generatePOLinesFromForecast(
  shopId: string,
  options: {
    supplierId: string;
    locationId: string;
    mode: ForecastMode;
    forecastDays?: number;
    startDate?: Date;
    endDate?: Date;
  }
): Promise<ForecastLine[]> {
  const { supplierId, locationId, mode, forecastDays = 30, startDate, endDate } = options;

  if (mode === "BLANK") return [];

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { primaryWarehouseLocation: true },
  });
  if (!shop) return [];

  const settings = await prisma.shopSetting.findUnique({
    where: { shopId },
  });
  const defaultLeadTime = settings?.defaultLeadTimeDays ?? 7;
  const defaultSafety = settings?.defaultSafetyDays ?? 3;

  const variants = await prisma.variant.findMany({
    where: {
      shopId,
      inventoryTracked: true,
      product: {
        deletedAt: null,
        status: { notIn: ["DRAFT", "ARCHIVED"] },
        OR: [{ productType: null }, { productType: { not: "Gift Card" } }],
      },
      variantSuppliers: { some: { supplierId } },
    },
    include: {
      product: true,
      inventoryLevels: { where: { locationId }, include: { location: true } },
      variantSuppliers: {
        where: { supplierId },
        include: { supplier: true },
        take: 1,
      },
    },
  });

  const onOrderByVariant = await getOnOrderByVariant(shopId);
  const lines: ForecastLine[] = [];

  for (const v of variants) {
    const level = v.inventoryLevels[0];
    const onHand = level?.available ?? 0;
    const onOrder = onOrderByVariant.get(v.id) ?? 0;
    const vs = v.variantSuppliers[0];
    const detailsComplete = vs ? hasCompleteSupplierDetails({ cost: vs.cost, leadTimeDays: vs.leadTimeDays }) : false;
    const leadTimeDays =
      vs?.leadTimeDays ?? vs?.supplier?.defaultLeadTimeDays ?? defaultLeadTime;
    const safetyDays = defaultSafety;

    let suggestedQty = 0;
    const hasMinMax = vs?.minStock != null && vs?.maxStock != null && vs.maxStock > 0;
    const isBelowMin = vs?.minStock != null && onHand < vs.minStock;

    if (mode === "FILL_SHELVES" || mode === "TARGET_STOCK") {
      // Min/max only: target = maxStock
      if (hasMinMax && onHand < (vs!.maxStock ?? 0)) {
        const target = vs!.maxStock!;
        const toOrder = Math.max(0, Math.ceil(target - onHand - onOrder));
        const minOrd = vs!.minOrderQty ?? 1;
        suggestedQty = toOrder > 0 ? Math.max(minOrd, toOrder) : 0;
      }
    } else if (mode === "FILL_SHELVES_IF_BELOW_MIN") {
      // Fill shelves only for variants below min stock
      if (hasMinMax && isBelowMin && onHand < (vs!.maxStock ?? 0)) {
        const target = vs!.maxStock!;
        const toOrder = Math.max(0, Math.ceil(target - onHand - onOrder));
        const minOrd = vs!.minOrderQty ?? 1;
        suggestedQty = toOrder > 0 ? Math.max(minOrd, toOrder) : 0;
      }
    } else if (mode === "YOY") {
      // Same period last year velocity
      if (detailsComplete) {
        const avgDailySales = await getVelocityYoY(v.id, forecastDays);
        suggestedQty =
          avgDailySales > 0
            ? Math.max(
                0,
                Math.ceil(
                  avgDailySales * leadTimeDays +
                    avgDailySales * safetyDays -
                    onHand -
                    onOrder
                )
              )
            : 0;
      } else if (hasMinMax && onHand < (vs!.maxStock ?? 0)) {
        const target = vs!.maxStock!;
        const toOrder = Math.max(0, Math.ceil(target - onHand - onOrder));
        const minOrd = vs!.minOrderQty ?? 1;
        suggestedQty = toOrder > 0 ? Math.max(minOrd, toOrder) : 0;
      }
    } else if (mode === "CUSTOM" && startDate && endDate) {
      // Custom date range velocity
      if (detailsComplete) {
        const avgDailySales = await getVelocityForDateRange(v.id, startDate, endDate);
        suggestedQty =
          avgDailySales > 0
            ? Math.max(
                0,
                Math.ceil(
                  avgDailySales * leadTimeDays +
                    avgDailySales * safetyDays -
                    onHand -
                    onOrder
                )
              )
            : 0;
      } else if (hasMinMax && onHand < (vs!.maxStock ?? 0)) {
        const target = vs!.maxStock!;
        const toOrder = Math.max(0, Math.ceil(target - onHand - onOrder));
        const minOrd = vs!.minOrderQty ?? 1;
        suggestedQty = toOrder > 0 ? Math.max(minOrd, toOrder) : 0;
      }
    } else if (mode === "SUGGESTION") {
      // Velocity-based, respect min/max when present
      if (hasMinMax) {
        const target = vs!.maxStock!;
        const toOrder = Math.max(0, Math.ceil(target - onHand - onOrder));
        const minOrd = vs!.minOrderQty ?? 1;
        suggestedQty = toOrder > 0 ? Math.max(minOrd, toOrder) : 0;
      } else if (detailsComplete) {
        const avgDailySales = await getVelocity(v.id, forecastDays);
        suggestedQty =
          avgDailySales > 0
            ? Math.max(
                0,
                Math.ceil(
                  avgDailySales * leadTimeDays +
                    avgDailySales * safetyDays -
                    onHand -
                    onOrder
                )
              )
            : 0;
      }
    }

    if (suggestedQty <= 0) continue;

    lines.push({
      variantId: v.id,
      quantity: suggestedQty,
      unitCost: vs?.cost ?? null,
      productTitle: v.product.title,
      variantTitle: v.title,
      sku: v.sku,
    });
  }

  return lines;
}
