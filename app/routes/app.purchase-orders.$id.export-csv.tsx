import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: params.id!, shopId: shop.id },
    include: {
      supplier: true,
      lines: { include: { variant: { include: { product: true } } } },
    },
  });
  if (!po) throw new Response("Not found", { status: 404 });

  const escape = (s: string) => {
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const header = ["SKU", "Product", "Variant", "Quantity", "Unit Cost"];
  const rows = po.lines.map((l) => [
    escape(l.variant.sku ?? ""),
    escape(l.variant.product.title),
    escape(l.variant.title),
    String(l.orderedQty),
    l.unitCost ?? "",
  ]);
  const csv = [header.join(","), ...rows.map((r) => r.join(","))].join("\n");

  const { formatPoDisplayNumber } = await import("../lib/format-po");
  const filename = `PO-${po.supplier.name.replace(/[^a-z0-9]/gi, "_")}-${formatPoDisplayNumber(po.poNumber)}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
};
