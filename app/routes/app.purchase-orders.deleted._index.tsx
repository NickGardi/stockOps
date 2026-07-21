import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link, useLoaderData, useFetcher } from "@remix-run/react";
import { useState } from "react";
import { Card, DataTable, BlockStack, Badge, EmptyState, Button, Banner, TextField, Box } from "@shopify/polaris";
import { PageShell } from "../components/PageShell";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { formatPoDisplayNumber } from "../lib/format-po";
import { restoreReceivedInventory } from "../services/receiving.server";

const STATUS_TONE: Record<string, "info" | "success" | "warning" | "critical"> = {
  DRAFT: "info",
  ORDERED: "warning",
  PARTIALLY_RECEIVED: "warning",
  RECEIVED: "success",
  CANCELED: "critical",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { orders: [] };

  const orders = await prisma.purchaseOrder.findMany({
    where: { shopId: shop.id, deletedAt: { not: null } },
    include: { supplier: true, lines: true },
    orderBy: { deletedAt: "desc" },
  });
  return { orders };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return json({ error: "Shop not found" }, { status: 404 });

  const formData = await request.formData();
  if (formData.get("intent") !== "restore") return json({ error: "Invalid intent" }, { status: 400 });
  const poId = String(formData.get("poId") || "").trim();
  if (!poId) return json({ error: "PO ID required" }, { status: 400 });

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, shopId: shop.id },
  });
  if (!po) return json({ error: "Purchase order not found" }, { status: 404 });
  if (!po.deletedAt) return json({ error: "PO is not deleted" }, { status: 400 });

  if (po.status === "RECEIVED") {
    const result = await restoreReceivedInventory(admin, shop.id, poId);
    if (!result.success) {
      return json({ error: result.error ?? "Failed to restore inventory" }, { status: 500 });
    }
  }

  await prisma.purchaseOrder.update({
    where: { id: poId },
    data: { deletedAt: null },
  });
  return redirect(`/app/purchase-orders/${poId}`);
};

function formatCurrency(n: number): string {
  return n.toFixed(2);
}

function formatDate(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function DeletedPurchaseOrdersList() {
  const { orders } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const [searchQuery, setSearchQuery] = useState("");

  const filteredOrders = searchQuery.trim()
    ? orders.filter((po) => {
        const q = searchQuery.trim().toLowerCase();
        const poLabel = formatPoDisplayNumber(po.poNumber).toLowerCase();
        const supplier = po.supplier.name.toLowerCase();
        const status = po.status.toLowerCase().replace(/_/g, " ");
        return poLabel.includes(q) || supplier.includes(q) || status.includes(q);
      })
    : orders;

  const rows = filteredOrders.map((po) => {
    const totalValue = po.lines.reduce((sum, l) => {
      const cost = parseFloat(l.unitCost ?? "0") || 0;
      return sum + cost * l.orderedQty;
    }, 0);
    return [
      <Link key={po.id} to={`/app/purchase-orders/${po.id}`}>
        {formatPoDisplayNumber(po.poNumber)}
      </Link>,
      po.supplier.name,
      po.lines.length,
      po.lines.reduce((s, l) => s + l.orderedQty, 0),
      `$${formatCurrency(totalValue)}`,
      <Badge key={po.id} tone={STATUS_TONE[po.status] ?? "info"}>
        {po.status.replace(/_/g, " ")}
      </Badge>,
      formatDate(po.deletedAt),
      <fetcher.Form key={po.id} method="post" style={{ display: "inline" }}>
        <input type="hidden" name="intent" value="restore" />
        <input type="hidden" name="poId" value={po.id} />
        <Button
          size="slim"
          submit
          loading={fetcher.state !== "idle"}
          disabled={fetcher.state !== "idle"}
        >
          Restore
        </Button>
      </fetcher.Form>,
    ];
  });

  const error = fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  return (
    <PageShell
      title="Deleted purchase orders"
      backAction={{ url: "/app/purchase-orders" }}
      primaryAction={{ content: "Back to purchase orders", url: "/app/purchase-orders" }}
    >
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" onDismiss={() => {}}>
            {error}
          </Banner>
        )}
        {orders.length === 0 ? (
          <Card>
            <EmptyState
              heading="No deleted purchase orders"
              action={{ content: "Back to purchase orders", url: "/app/purchase-orders" }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>Deleted purchase orders are kept here for your records. They never appear on the main list.</p>
            </EmptyState>
          </Card>
        ) : (
          <Card>
            <BlockStack gap="400">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                <p style={{ margin: 0, color: "var(--p-color-text-subdued)", fontSize: "var(--p-font-size-200)" }}>
                  These purchase orders were removed from the main list but are kept for your records. You can view details but cannot edit or receive them.
                </p>
                <Button url="/app/purchase-orders">Back to purchase orders</Button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
                <Box minWidth="200px" flexGrow={1}>
                  <TextField
                    label=""
                    labelHidden
                    value={searchQuery}
                    onChange={setSearchQuery}
                    placeholder="Search"
                    autoComplete="off"
                    clearButton
                    onClearButtonClick={() => setSearchQuery("")}
                  />
                </Box>
              </div>
              {filteredOrders.length === 0 ? (
                <EmptyState
                  heading="No matching purchase orders"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>Try a different search term or clear the search.</p>
                </EmptyState>
              ) : (
              <DataTable
                columnContentTypes={["text", "text", "numeric", "numeric", "text", "text", "text", "text"]}
                headings={["PO", "Supplier", "Lines", "Total Qty", "Total Value", "Status", "Deleted", ""]}
                rows={rows}
              />
              )}
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </PageShell>
  );
}
