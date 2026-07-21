import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { formatPoDisplayNumber } from "../lib/format-po";
import { formatAddress } from "../lib/address";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: params.id!, shopId: shop.id },
    include: {
      supplier: true,
      receivingLocation: true,
      lines: { include: { variant: { include: { product: true } } } },
    },
  });
  if (!po) throw new Response("Not found", { status: 404 });

  const subtotal = po.lines.reduce((sum, l) => {
    const cost = parseFloat(l.unitCost ?? "0") || 0;
    return sum + cost * l.orderedQty;
  }, 0);
  const total = subtotal;

  const formatCurrency = (n: number) => n.toFixed(2);
  const escape = (s: string) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const supplierAddressFormatted = formatAddress({
    address1: po.supplier.address1 ?? undefined,
    address2: po.supplier.address2 ?? undefined,
    city: po.supplier.city ?? undefined,
    provinceCode: po.supplier.provinceCode ?? undefined,
    zip: po.supplier.zip ?? undefined,
    countryCode: po.supplier.countryCode ?? "US",
  });

  const shopLabel = shop.domain.replace(/\.myshopify\.com$/i, "");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Purchase Order ${formatPoDisplayNumber(po.poNumber)} - ${escape(po.supplier.name)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; color: #111; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; }
    .parties { display: flex; gap: 32px; margin: 24px 0; flex-wrap: wrap; }
    .party { flex: 1; min-width: 220px; }
    .party h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: #666; margin: 0 0 8px; }
    .party .name { font-weight: 600; font-size: 1.05rem; margin-bottom: 4px; }
    .meta { color: #666; font-size: 0.9rem; margin-bottom: 16px; line-height: 1.5; }
    .notes { margin: 20px 0; padding: 12px 16px; background: #f7f7f7; border-radius: 6px; white-space: pre-wrap; }
    .notes h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: #666; margin: 0 0 8px; }
    table { width: 100%; border-collapse: collapse; margin: 24px 0; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
    th { background: #f5f5f5; font-weight: 600; }
    .totals { margin-top: 24px; text-align: right; }
    .totals table { width: auto; margin-left: auto; }
    .totals td:first-child { text-align: right; padding-right: 24px; }
    @media print { body { margin: 0; } }
  </style>
</head>
<body>
  <h1>Purchase Order ${formatPoDisplayNumber(po.poNumber)}</h1>
  <div class="meta">
    <strong>Date:</strong> ${po.orderedAt ? new Date(po.orderedAt).toLocaleDateString() : new Date().toLocaleDateString()}
    ${po.supplierOrderNumber ? `<br><strong>Supplier order #:</strong> ${escape(po.supplierOrderNumber)}` : ""}
    ${po.invoiceNumber ? `<br><strong>Invoice #:</strong> ${escape(po.invoiceNumber)}` : ""}
    ${po.expectedShipmentAt ? `<br><strong>Expected shipment:</strong> ${new Date(po.expectedShipmentAt).toLocaleDateString()}` : ""}
  </div>

  <div class="parties">
    <div class="party">
      <h2>Supplier</h2>
      <div class="name">${escape(po.supplier.name)}</div>
      ${po.supplier.email ? `${escape(po.supplier.email)}<br>` : ""}
      ${po.supplier.phone ? `${escape(po.supplier.phone)}<br>` : ""}
      ${supplierAddressFormatted ? escape(supplierAddressFormatted).replace(/\n/g, "<br>") : ""}
    </div>
    <div class="party">
      <h2>Ship to</h2>
      <div class="name">${escape(shopLabel)}</div>
      ${po.receivingLocation ? `${escape(po.receivingLocation.name)}<br>` : ""}
      ${escape(shop.domain)}
    </div>
  </div>

  ${
    po.notes
      ? `<div class="notes"><h2>Notes</h2>${escape(po.notes)}</div>`
      : ""
  }

  <table>
    <thead>
      <tr>
        <th>Product</th>
        <th>SKU</th>
        <th>Quantity</th>
        <th>Unit Cost</th>
        <th>Total</th>
      </tr>
    </thead>
    <tbody>
      ${po.lines
        .map(
          (l) => `
      <tr>
        <td>${escape(l.variant.product.title)} - ${escape(l.variant.title)}</td>
        <td>${escape(l.variant.sku ?? "")}</td>
        <td>${l.orderedQty}</td>
        <td>${l.unitCost ?? "—"}</td>
        <td>${formatCurrency((parseFloat(l.unitCost ?? "0") || 0) * l.orderedQty)}</td>
      </tr>`
        )
        .join("")}
    </tbody>
  </table>

  <div class="totals">
    <table>
      <tr><td><strong>Total</strong></td><td><strong>${formatCurrency(total)}</strong></td></tr>
    </table>
  </div>

</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
};
