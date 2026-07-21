/**
 * Dashboard data aggregation for v1 upgrade.
 * Summary stats + top reorder risks.
 */

import prisma from "../db.server";
import { getReorderSuggestions, type ReorderRow, type VelocityMode } from "./reorder.server";
export type { VelocityMode };

export type DashboardRiskRow = ReorderRow & {
  daysOfCover: number | null;
};

export type DashboardData = {
  itemsToReorderCount: number;
  openPOCount: number;
  draftPOCount: number;
  awaitingPOCount: number;
  incomingUnits: number;
  stockoutsUnder7DaysCount: number;
  topReorderRisks: DashboardRiskRow[];
  productCount: number;
  variantCount: number;
  bestSellers: Array<{
    variantId: string;
    productTitle: string;
    variantTitle: string;
    unitsSold: number;
    revenue: number;
    cost: number | null;
    profit: number | null;
    marginPct: number | null;
  }>;
  lostRevenue: number | null;
  suggestedOrderCost: number; // total cost to place current recommended reorders (unit cost × suggested qty)
};

/**
 * Compute days of cover: (onHand + onOrder) / avgDailySales.
 * Returns null when avgDailySales is 0 (no demand = "—").
 */
export function computeDaysOfCover(onHand: number, onOrder: number, avgDailySales: number): number | null {
  if (avgDailySales <= 0) return null;
  return (onHand + onOrder) / avgDailySales;
}

export type ModeCounts = {
  itemsToReorder: number;
  criticalCount: number; // daysOfCover < leadTime - will lose money
  fixableCount: number; // suggestedQty > 0 but daysOfCover >= leadTime - order now to fix
};

export async function getDashboardCountsByMode(shopId: string): Promise<Record<VelocityMode, ModeCounts>> {
  const modes: VelocityMode[] = ["last30", "last60", "yoy", "fillToTarget"];
  const results = await Promise.all(
    modes.map(async (mode) => {
      const windowDays = mode === "last30" ? 30 : 60;
      const rows = await getReorderSuggestions(shopId, { lowStockOnly: false, windowDays, velocityMode: mode });
      const rowsWithCover = rows.map((r) => {
        const daysOfCover = r.daysOfCover ?? computeDaysOfCover(r.onHand, r.onOrder, r.avgDailySales);
        return { ...r, daysOfCover };
      });
      const itemsToReorder = rowsWithCover.filter((r) => r.suggestedQty > 0).length;
      // Critical: will stock out before order arrives (daysOfCover < leadTime)
      const criticalCount = rowsWithCover.filter(
        (r) => r.suggestedQty > 0 && r.avgDailySales > 0 && r.daysOfCover != null && (r.daysOfCover ?? 999) < r.leadTimeDays
      ).length;
      // Fixable: need to order but we have time (daysOfCover >= leadTime)
      const fixableCount = rowsWithCover.filter(
        (r) => r.suggestedQty > 0 && (r.avgDailySales === 0 || r.daysOfCover == null || (r.daysOfCover ?? 0) >= r.leadTimeDays)
      ).length;
      return { mode, counts: { itemsToReorder, criticalCount, fixableCount } };
    })
  );
  return Object.fromEntries(results.map((r) => [r.mode, r.counts])) as Record<VelocityMode, ModeCounts>;
}

export async function getDashboardData(shopId: string, options?: { velocityMode?: VelocityMode }): Promise<DashboardData> {
  const velocityMode = options?.velocityMode ?? "last60";
  const windowDays = velocityMode === "last30" ? 30 : 60; // yoy uses 60 for comparison period, fillToTarget ignores

  const [rows, openPOs, counts, salesLast30] = await Promise.all([
    getReorderSuggestions(shopId, { lowStockOnly: false, windowDays, velocityMode }),
    prisma.purchaseOrder.findMany({
      where: {
        shopId,
        deletedAt: null,
        status: { in: ["DRAFT", "ORDERED", "PARTIALLY_RECEIVED"] },
      },
      include: { lines: true },
    }),
    Promise.all([
      prisma.product.count({ where: { shopId, deletedAt: null } }),
      prisma.variant.count({ where: { shopId } }),
    ]),
    prisma.salesDaily.findMany({
      where: {
        shopId,
        date: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      select: { variantId: true, unitsSold: true },
    }),
  ]);

  const [productCount, variantCount] = counts;

  const rowsWithCover: DashboardRiskRow[] = rows.map((r) => {
    const daysOfCover = r.daysOfCover ?? computeDaysOfCover(r.onHand, r.onOrder, r.avgDailySales);
    return { ...r, daysOfCover };
  });

  const itemsToReorderCount = rowsWithCover.filter((r) => r.suggestedQty > 0).length;
  const stockoutsUnder7DaysCount = rowsWithCover.filter(
    (r) => r.avgDailySales > 0 && r.daysOfCover != null && r.daysOfCover < 7
  ).length;

  let incomingUnits = 0;
  for (const po of openPOs) {
    if (po.status === "DRAFT") continue;
    for (const line of po.lines) {
      const pending = line.orderedQty - line.receivedQty;
      if (pending > 0) incomingUnits += pending;
    }
  }

  const topReorderRisks = rowsWithCover
    .filter((r) => r.suggestedQty > 0 || (r.avgDailySales > 0 && r.daysOfCover != null && r.daysOfCover < 7))
    .sort((a, b) => {
      const coverA = a.daysOfCover ?? 999;
      const coverB = b.daysOfCover ?? 999;
      if (coverA !== coverB) return coverA - coverB;
      return b.suggestedQty - a.suggestedQty;
    })
    .slice(0, 10);

  const draftPOCount = openPOs.filter((po) => po.status === "DRAFT").length;
  const awaitingPOCount = openPOs.filter((po) =>
    po.status === "ORDERED" || po.status === "PARTIALLY_RECEIVED"
  ).length;

  const salesByVariant = new Map<string, number>();
  for (const s of salesLast30) {
    salesByVariant.set(s.variantId, (salesByVariant.get(s.variantId) ?? 0) + s.unitsSold);
  }
  const bestSellerVariantIds = [...salesByVariant.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([vid]) => vid);

  const bestSellerVariants =
    bestSellerVariantIds.length > 0
      ? await prisma.variant.findMany({
          where: { id: { in: bestSellerVariantIds } },
          include: { product: true, variantSuppliers: { take: 1 } },
        })
      : [];
  const bestSellers = bestSellerVariantIds
    .map((vid) => {
      const v = bestSellerVariants.find((x) => x.id === vid);
      const units = salesByVariant.get(vid) ?? 0;
      if (!v) return null;
      const price = parseFloat(v.price);
      const costStr = v.variantSuppliers[0]?.cost ?? null;
      const costNum = costStr != null ? parseFloat(costStr) : NaN;
      const revenue = !Number.isNaN(price) ? price * units : 0;
      const cost = !Number.isNaN(costNum) && costNum >= 0 ? costNum * units : null;
      const profit = cost != null ? revenue - cost : null;
      const marginPct =
        !Number.isNaN(price) && price > 0 && !Number.isNaN(costNum) && costNum >= 0
          ? ((price - costNum) / price) * 100
          : null;
      return {
        variantId: v.id,
        productTitle: v.product.title,
        variantTitle: v.title,
        unitsSold: units,
        revenue,
        cost,
        profit,
        marginPct,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  let lostRevenue: number | null = null;
  const stockoutRows = rowsWithCover.filter(
    (r) => r.avgDailySales > 0 && r.daysOfCover != null && r.daysOfCover < 7
  );
  if (stockoutRows.length > 0) {
    lostRevenue = stockoutRows.reduce((sum, r) => {
      const price = parseFloat(r.retailPrice);
      const daysShort = Math.max(0, 7 - (r.daysOfCover ?? 0));
      const lostUnits = r.avgDailySales * daysShort;
      return sum + (Number.isNaN(price) ? 0 : price * lostUnits);
    }, 0);
  }

  // Suggested order cost: total cost to place current recommended reorders.
  const suggestedOrderCost = rowsWithCover
    .filter((r) => r.suggestedQty > 0)
    .reduce((sum, r) => {
      const cost = r.unitCost != null ? parseFloat(r.unitCost) : NaN;
      return sum + (Number.isNaN(cost) || cost < 0 ? 0 : cost * r.suggestedQty);
    }, 0);

  return {
    itemsToReorderCount,
    openPOCount: openPOs.length,
    draftPOCount,
    awaitingPOCount,
    incomingUnits,
    stockoutsUnder7DaysCount,
    topReorderRisks,
    productCount,
    variantCount,
    bestSellers,
    lostRevenue,
    suggestedOrderCost,
  };
}
