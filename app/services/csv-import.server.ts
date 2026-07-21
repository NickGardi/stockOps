/**
 * CSV import for PO lines and stock transfer lines.
 * Format: SKU or variantId, quantity, optional cost (PO only)
 */

import prisma from "../db.server";

export type POLineImportRow = {
  skuOrId: string;
  quantity: number;
  cost?: string;
};

export type TransferLineImportRow = {
  skuOrId: string;
  quantity: number;
};

export function parsePOLinesCSV(csvText: string): POLineImportRow[] {
  const lines = csvText.trim().split(/\r?\n/).filter(Boolean);
  const rows: POLineImportRow[] = [];
  const header = lines[0]?.toLowerCase();
  const startIdx = header?.includes("sku") || header?.includes("quantity") ? 1 : 0;

  for (let i = startIdx; i < lines.length; i++) {
    const cells = parseCSVLine(lines[i]);
    if (cells.length < 2) continue;
    const skuOrId = cells[0]?.trim() ?? "";
    const qty = parseInt(cells[1]?.trim() ?? "0", 10);
    if (!skuOrId || Number.isNaN(qty) || qty < 1) continue;
    rows.push({
      skuOrId,
      quantity: qty,
      cost: cells[2]?.trim() || undefined,
    });
  }
  return rows;
}

export function parseTransferLinesCSV(csvText: string): TransferLineImportRow[] {
  const lines = csvText.trim().split(/\r?\n/).filter(Boolean);
  const rows: TransferLineImportRow[] = [];
  const header = lines[0]?.toLowerCase();
  const startIdx = header?.includes("sku") || header?.includes("quantity") ? 1 : 0;

  for (let i = startIdx; i < lines.length; i++) {
    const cells = parseCSVLine(lines[i]);
    if (cells.length < 2) continue;
    const skuOrId = cells[0]?.trim() ?? "";
    const qty = parseInt(cells[1]?.trim() ?? "0", 10);
    if (!skuOrId || Number.isNaN(qty) || qty < 1) continue;
    rows.push({ skuOrId, quantity: qty });
  }
  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (inQuotes) {
      current += c;
    } else if (c === "," || c === "\t") {
      result.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  result.push(current.trim());
  return result;
}

export async function importPOLines(
  shopId: string,
  purchaseOrderId: string,
  rows: POLineImportRow[]
): Promise<{ added: number; errors: string[] }> {
  const errors: string[] = [];
  let added = 0;

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, shopId, deletedAt: null },
  });
  if (!po || po.status !== "DRAFT") {
    return { added: 0, errors: ["PO not found or not in draft"] };
  }

  for (const row of rows) {
    const variant = await prisma.variant.findFirst({
      where: {
        shopId,
        OR: [
          { sku: row.skuOrId },
          { id: row.skuOrId },
        ],
      },
      include: { variantSuppliers: { where: { supplierId: po.supplierId }, take: 1 } },
    });

    if (!variant) {
      errors.push(`Variant not found: ${row.skuOrId}`);
      continue;
    }

    const vs = variant.variantSuppliers[0];
    const unitCost = row.cost ?? vs?.cost ?? null;

    await prisma.purchaseOrderLine.upsert({
      where: {
        purchaseOrderId_variantId: { purchaseOrderId, variantId: variant.id },
      },
      create: {
        purchaseOrderId,
        variantId: variant.id,
        orderedQty: row.quantity,
        unitCost,
      },
      update: {
        orderedQty: { increment: row.quantity },
        unitCost: unitCost ?? undefined,
      },
    });
    added++;
  }
  return { added, errors };
}

export async function importTransferLines(
  shopId: string,
  stockTransferId: string,
  rows: TransferLineImportRow[]
): Promise<{ added: number; errors: string[] }> {
  const errors: string[] = [];
  let added = 0;

  const transfer = await prisma.stockTransfer.findFirst({
    where: { id: stockTransferId, shopId },
  });
  if (!transfer || transfer.status !== "DRAFT") {
    return { added: 0, errors: ["Transfer not found or not in draft"] };
  }

  for (const row of rows) {
    const variant = await prisma.variant.findFirst({
      where: {
        shopId,
        OR: [
          { sku: row.skuOrId },
          { id: row.skuOrId },
        ],
      },
    });

    if (!variant) {
      errors.push(`Variant not found: ${row.skuOrId}`);
      continue;
    }

    await prisma.stockTransferLine.upsert({
      where: {
        stockTransferId_variantId: { stockTransferId, variantId: variant.id },
      },
      create: {
        stockTransferId,
        variantId: variant.id,
        quantity: row.quantity,
      },
      update: { quantity: { increment: row.quantity } },
    });
    added++;
  }
  return { added, errors };
}
