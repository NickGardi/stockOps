import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const transfer = await prisma.stockTransfer.findFirst({
    where: { id: params.id!, shopId: shop.id },
    include: {
      sourceLocation: true,
      destLocation: true,
      lines: { include: { variant: { include: { product: true } } } },
    },
  });
  if (!transfer) throw new Response("Not found", { status: 404 });

  const escape = (s: string) => {
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const header = ["SKU or Variant ID", "Quantity"];
  const rows = transfer.lines.map((l) => [
    escape(l.variant.sku ?? l.variant.id),
    String(l.quantity),
  ]);
  const csv = [header.join(","), ...rows.map((r) => r.join(","))].join("\n");

  const filename = `transfer-${transfer.sourceLocation.name.replace(/[^a-z0-9]/gi, "_")}-to-${transfer.destLocation.name.replace(/[^a-z0-9]/gi, "_")}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
};
