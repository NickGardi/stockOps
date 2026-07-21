/**
 * Supplier assignment: bulk assign variants to suppliers.
 * v1: One supplier per variant. Assigning replaces existing.
 */

import prisma from "../db.server";
import { getVelocity } from "./sales-velocity.server";

export type VariantForAssign = {
  id: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  supplierName: string | null;
  onHand: number;
  soldLast30Days: number;
};

export async function getUnassignedVariantCount(shopId: string): Promise<number> {
  return prisma.variant.count({
    where: { shopId, variantSuppliers: { none: {} } },
  });
}

export async function getVariantsForAssign(
  shopId: string,
  options: {
    search?: string;
    unassignedOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {}
): Promise<{ variants: VariantForAssign[]; total: number }> {
  const { search, unassignedOnly = false, limit = 100, offset = 0 } = options;

  const where = {
    shopId,
    ...(search
      ? {
          OR: [
            { sku: { contains: search } },
            { title: { contains: search } },
            { product: { title: { contains: search } } },
          ],
        }
      : {}),
    ...(unassignedOnly
      ? { variantSuppliers: { none: {} } }
      : {}),
  };

  const [variants, total] = await Promise.all([
    prisma.variant.findMany({
      where,
      include: {
        product: true,
        variantSuppliers: { include: { supplier: true }, take: 1 },
      },
      orderBy: [{ product: { title: "asc" } }, { title: "asc" }],
      take: limit,
      skip: offset,
    }),
    prisma.variant.count({ where }),
  ]);

  const onHandByVariant = await getOnHandByVariant(shopId);

  const result: VariantForAssign[] = [];
  for (const v of variants) {
    const vs = v.variantSuppliers[0];
    const onHand = onHandByVariant.get(v.id) ?? 0;
    const soldLast30Days = await getVelocity(v.id, 30);
    result.push({
      id: v.id,
      productTitle: v.product.title,
      variantTitle: v.title,
      sku: v.sku,
      supplierName: vs?.supplier?.name ?? null,
      onHand,
      soldLast30Days,
    });
  }

  return { variants: result, total };
}

async function getOnHandByVariant(shopId: string): Promise<Map<string, number>> {
  const levels = await prisma.inventoryLevel.findMany({
    where: { shopId },
    select: { variantId: true, available: true },
  });
  const map = new Map<string, number>();
  for (const l of levels) {
    map.set(l.variantId, (map.get(l.variantId) ?? 0) + l.available);
  }
  return map;
}

export async function bulkAssignVariants(
  shopId: string,
  variantIds: string[],
  supplierId: string,
  options: {
    unitCost?: string | null;
    leadTimeDays?: number | null;
    supplierSku?: string | null;
  } = {}
): Promise<{ assigned: number; error?: string }> {
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, shopId },
  });
  if (!supplier) return { assigned: 0, error: "Supplier not found" };

  const validVariants = await prisma.variant.findMany({
    where: { id: { in: variantIds }, shopId },
    select: { id: true },
  });
  const validIds = new Set(validVariants.map((v) => v.id));

  const costRaw = options.unitCost?.trim() || null;
  const cost =
    costRaw != null && costRaw !== ""
      ? (() => {
          const n = parseFloat(costRaw);
          return !Number.isNaN(n) && n >= 0 ? costRaw : null;
        })()
      : null;
  const leadTimeDays =
    options.leadTimeDays != null && Number.isInteger(options.leadTimeDays) && options.leadTimeDays >= 0
      ? options.leadTimeDays
      : supplier.defaultLeadTimeDays ?? null;
  const skuAtSupplier = options.supplierSku?.trim() || null;

  let assigned = 0;
  for (const variantId of validIds) {
    await prisma.variantSupplier.deleteMany({
      where: { variantId },
    });
    await prisma.variantSupplier.create({
      data: {
        variantId,
        supplierId,
        cost,
        leadTimeDays,
        skuAtSupplier,
      },
    });
    assigned++;
  }

  return { assigned };
}

export type VariantForCompletion = {
  variantId: string;
  variantSupplierId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  supplierName: string;
  cost: string | null;
  leadTimeDays: number | null;
  skuAtSupplier: string | null;
};

export async function getVariantsForCompletion(
  shopId: string,
  variantIds: string[]
): Promise<VariantForCompletion[]> {
  if (variantIds.length === 0) return [];

  const variants = await prisma.variant.findMany({
    where: { id: { in: variantIds }, shopId },
    include: {
      product: true,
      variantSuppliers: { include: { supplier: true }, take: 1 },
    },
  });

  const result: VariantForCompletion[] = [];
  for (const v of variants) {
    const vs = v.variantSuppliers[0];
    if (!vs) continue;
    result.push({
      variantId: v.id,
      variantSupplierId: vs.id,
      productTitle: v.product.title,
      variantTitle: v.title,
      sku: v.sku,
      supplierName: vs.supplier.name,
      cost: vs.cost,
      leadTimeDays: vs.leadTimeDays,
      skuAtSupplier: vs.skuAtSupplier,
    });
  }
  return result;
}

export async function updateVariantSupplierDetails(
  shopId: string,
  updates: Array<{ variantSupplierId: string; cost: string | null; leadTimeDays: number | null; skuAtSupplier?: string | null }>
): Promise<{ updated: number; error?: string }> {
  let updated = 0;
  for (const u of updates) {
    const vs = await prisma.variantSupplier.findFirst({
      where: { id: u.variantSupplierId },
      include: { variant: true },
    });
    if (!vs || vs.variant.shopId !== shopId) continue;

    const costVal = u.cost?.trim();
    const costValid = costVal !== "" && !Number.isNaN(parseFloat(costVal || "")) && parseFloat(costVal || "") >= 0;
    const leadTimeValid = u.leadTimeDays != null && u.leadTimeDays >= 0;
    await prisma.variantSupplier.update({
      where: { id: u.variantSupplierId },
      data: {
        cost: costValid ? (costVal || null) : null,
        leadTimeDays: leadTimeValid ? u.leadTimeDays : null,
        skuAtSupplier: u.skuAtSupplier ?? vs.skuAtSupplier,
      },
    });
    updated++;
  }
  return { updated };
}

/** Cost + lead time only - used for reorder suggestions ("Details required") */
export function hasCompleteSupplierDetails(vs: { cost: string | null; leadTimeDays: number | null }): boolean {
  const costValid = vs.cost != null && vs.cost.trim() !== "" && !Number.isNaN(parseFloat(vs.cost)) && parseFloat(vs.cost) >= 0;
  const leadTimeValid = vs.leadTimeDays != null && vs.leadTimeDays >= 0;
  return costValid && leadTimeValid;
}

/** All 5 fields - used for supplier list status (green/red dot) */
export function hasCompleteSupplierDetailsStrict(vs: {
  cost: string | null;
  leadTimeDays: number | null;
  minStock?: number | null;
  maxStock?: number | null;
  minOrderQty?: number | null;
}): boolean {
  if (!hasCompleteSupplierDetails(vs)) return false;
  const minStockValid = vs.minStock != null && vs.minStock >= 0;
  const maxStockValid = vs.maxStock != null && vs.maxStock >= 0;
  const minOrderQtyValid = vs.minOrderQty != null && vs.minOrderQty >= 0;
  return minStockValid && maxStockValid && minOrderQtyValid;
}

export async function getIncompleteVariantCount(shopId: string): Promise<number> {
  const all = await prisma.variantSupplier.findMany({
    where: { variant: { shopId } },
    select: { cost: true, leadTimeDays: true, minStock: true, maxStock: true, minOrderQty: true },
  });
  return all.filter((vs) => !hasCompleteSupplierDetails(vs)).length;
}

export async function getIncompleteVariantIds(shopId: string): Promise<string[]> {
  const all = await prisma.variantSupplier.findMany({
    where: { variant: { shopId } },
    select: { variantId: true, cost: true, leadTimeDays: true, minStock: true, maxStock: true, minOrderQty: true },
  });
  return all.filter((vs) => !hasCompleteSupplierDetails(vs)).map((vs) => vs.variantId);
}

export async function getIncompleteCountBySupplier(shopId: string): Promise<Map<string, number>> {
  const all = await prisma.variantSupplier.findMany({
    where: { variant: { shopId } },
    select: { supplierId: true, cost: true, leadTimeDays: true, minStock: true, maxStock: true, minOrderQty: true },
  });
  const map = new Map<string, number>();
  for (const vs of all) {
    if (!hasCompleteSupplierDetailsStrict(vs)) {
      map.set(vs.supplierId, (map.get(vs.supplierId) ?? 0) + 1);
    }
  }
  return map;
}

export async function assignSingleVariant(
  shopId: string,
  variantId: string,
  supplierId: string,
  options: { unitCost: string; leadTimeDays: number }
): Promise<{ success: boolean; error?: string }> {
  return bulkAssignVariants(shopId, [variantId], supplierId, {
    ...options,
    supplierSku: null,
  }).then((r) =>
    r.assigned > 0 ? { success: true } : { success: false, error: r.error || "Failed" }
  );
}
