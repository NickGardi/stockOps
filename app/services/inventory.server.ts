/**
 * Inventory browser: variant × location stock view for merchants.
 */

import prisma from "../db.server";
import { getOnOrderByVariant } from "./reorder.server";

export type InventoryStatus = "IN_STOCK" | "LOW" | "OUT" | "OVERSTOCK";

export type InventoryRow = {
  variantId: string;
  locationId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  locationName: string;
  onHand: number;
  onOrder: number;
  daysOfCover: number | null;
  avgDailySales: number;
  supplierName: string | null;
  minStock: number | null;
  maxStock: number | null;
  status: InventoryStatus;
};

function computeStatus(
  onHand: number,
  minStock: number | null,
  maxStock: number | null,
  daysOfCover: number | null
): InventoryStatus {
  if (onHand <= 0) return "OUT";
  if (maxStock != null && onHand > maxStock) return "OVERSTOCK";
  if (minStock != null && onHand < minStock) return "LOW";
  if (daysOfCover != null && daysOfCover < 14) return "LOW";
  return "IN_STOCK";
}

async function getVelocityByVariant(
  variantIds: string[],
  windowDays: number
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (variantIds.length === 0) return map;

  const since = new Date();
  since.setDate(since.getDate() - windowDays);
  since.setHours(0, 0, 0, 0);

  const rows = await prisma.salesDaily.groupBy({
    by: ["variantId"],
    where: { variantId: { in: variantIds }, date: { gte: since } },
    _sum: { unitsSold: true },
  });

  for (const r of rows) {
    const total = r._sum.unitsSold ?? 0;
    map.set(r.variantId, windowDays > 0 ? total / windowDays : 0);
  }
  return map;
}

export async function getInventoryRows(
  shopId: string,
  options: {
    locationId?: string;
    search?: string;
    status?: InventoryStatus | "ALL";
    limit?: number;
  } = {}
): Promise<InventoryRow[]> {
  const { locationId, search, status = "ALL", limit = 500 } = options;
  const windowDays = 60;

  const [onOrderByVariant, locations] = await Promise.all([
    getOnOrderByVariant(shopId),
    prisma.location.findMany({
      where: {
        shopId,
        isActive: true,
        ...(locationId ? { id: locationId } : {}),
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  if (locations.length === 0) return [];

  const locationIds = locations.map((l) => l.id);
  const locationNameById = new Map(locations.map((l) => [l.id, l.name]));

  const variants = await prisma.variant.findMany({
    where: {
      shopId,
      inventoryTracked: true,
      product: {
        deletedAt: null,
        status: { notIn: ["DRAFT", "ARCHIVED"] },
        OR: [{ productType: null }, { productType: { not: "Gift Card" } }],
      },
      ...(search
        ? {
            OR: [
              { sku: { contains: search } },
              { title: { contains: search } },
              { product: { title: { contains: search } } },
            ],
          }
        : {}),
    },
    include: {
      product: true,
      inventoryLevels: {
        where: { locationId: { in: locationIds } },
      },
      variantSuppliers: {
        include: { supplier: true },
        take: 1,
      },
    },
    orderBy: [{ product: { title: "asc" } }, { title: "asc" }],
    take: Math.min(limit, 1000),
  });

  const velocityByVariant = await getVelocityByVariant(
    variants.map((v) => v.id),
    windowDays
  );

  const rows: InventoryRow[] = [];

  for (const v of variants) {
    const vs = v.variantSuppliers[0];
    const onOrder = onOrderByVariant.get(v.id) ?? 0;
    const avgDailySales = velocityByVariant.get(v.id) ?? 0;

    const levelsByLoc = new Map(v.inventoryLevels.map((il) => [il.locationId, il.available]));

    for (const loc of locations) {
      // If filtering a single location, always show a row (0 if no level)
      // If all locations, only show locations that have a level OR show all with 0 — Stocky shows all managed locations
      const onHand = levelsByLoc.get(loc.id) ?? 0;
      if (!locationId && !levelsByLoc.has(loc.id) && onHand === 0) {
        // Skip zero rows at locations never stocked to reduce noise when browsing all locations
        continue;
      }

      const daysOfCover =
        avgDailySales > 0 ? (onHand + onOrder) / avgDailySales : null;
      const rowStatus = computeStatus(
        onHand,
        vs?.minStock ?? null,
        vs?.maxStock ?? null,
        daysOfCover
      );

      if (status !== "ALL" && rowStatus !== status) continue;

      rows.push({
        variantId: v.id,
        locationId: loc.id,
        productTitle: v.product.title,
        variantTitle: v.title,
        sku: v.sku,
        locationName: loc.name,
        onHand,
        onOrder,
        daysOfCover,
        avgDailySales,
        supplierName: vs?.supplier.name ?? null,
        minStock: vs?.minStock ?? null,
        maxStock: vs?.maxStock ?? null,
        status: rowStatus,
      });
    }
  }

  const statusOrder: Record<InventoryStatus, number> = {
    OUT: 0,
    LOW: 1,
    OVERSTOCK: 2,
    IN_STOCK: 3,
  };
  rows.sort((a, b) => {
    const s = statusOrder[a.status] - statusOrder[b.status];
    if (s !== 0) return s;
    return (
      a.productTitle.localeCompare(b.productTitle) ||
      a.variantTitle.localeCompare(b.variantTitle) ||
      a.locationName.localeCompare(b.locationName)
    );
  });

  return rows.slice(0, limit);
}
