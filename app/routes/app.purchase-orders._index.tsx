import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData, useFetcher } from "@remix-run/react";
import { useState } from "react";
import { Card, DataTable, BlockStack, Badge, EmptyState, Button, Modal, InlineStack, TextField, Tooltip, Box } from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { PageShell } from "../components/PageShell";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { formatPoDisplayNumber } from "../lib/format-po";
import { backfillPoNumbers } from "../services/purchase-order.server";
import { reverseReceivedInventory } from "../services/receiving.server";

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

  try {
    await backfillPoNumbers(shop.id);
  } catch {
    // Backfill is best-effort; don't break the page if it fails
  }
  const orders = await prisma.purchaseOrder.findMany({
    where: { shopId: shop.id, deletedAt: null },
    include: { supplier: true, lines: true },
    orderBy: { createdAt: "desc" },
  });
  return { orders };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return json({ error: "Shop not found" }, { status: 404 });

  const formData = await request.formData();
  if (formData.get("intent") !== "delete") return json({ error: "Invalid intent" }, { status: 400 });
  const poId = String(formData.get("poId") || "").trim();
  if (!poId) return json({ error: "PO ID required" }, { status: 400 });

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, shopId: shop.id },
  });
  if (!po) return json({ error: "Purchase order not found" }, { status: 404 });

  if (!["DRAFT", "CANCELED", "RECEIVED"].includes(po.status)) {
    return json({ error: "Can only delete draft, canceled, or received POs" }, { status: 400 });
  }

  if (po.status === "RECEIVED") {
    const result = await reverseReceivedInventory(admin, shop.id, poId);
    if (!result.success) {
      return json({ error: result.error ?? "Failed to reverse inventory" }, { status: 500 });
    }
  }

  await prisma.purchaseOrder.update({
    where: { id: poId },
    data: { deletedAt: new Date() },
  });
  return json({ success: true });
};

function formatCurrency(n: number): string {
  return n.toFixed(2);
}

function formatStatusDate(po: { status: string; orderedAt: Date | null; updatedAt: Date }): string {
  if (["ORDERED", "PARTIALLY_RECEIVED", "RECEIVED"].includes(po.status) && po.orderedAt) {
    return new Date(po.orderedAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  return new Date(po.updatedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function PurchaseOrdersList() {
  const { orders } = useLoaderData<typeof loader>();
  const [searchQuery, setSearchQuery] = useState("");
  const [poToDelete, setPoToDelete] = useState<{ id: string; label: string; status: string } | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const fetcher = useFetcher();

  const filteredOrders = searchQuery.trim()
    ? orders.filter((po) => {
        const q = searchQuery.trim().toLowerCase();
        const poLabel = formatPoDisplayNumber(po.poNumber).toLowerCase();
        const supplier = po.supplier.name.toLowerCase();
        const status = po.status.toLowerCase().replace(/_/g, " ");
        return poLabel.includes(q) || supplier.includes(q) || status.includes(q);
      })
    : orders;

  const isReceivedDelete = poToDelete?.status === "RECEIVED";
  const canConfirmReceivedDelete = deleteConfirmInput.trim() === (poToDelete?.label ?? "");

  const handleDeleteConfirm = () => {
    if (!poToDelete) return;
    const formData = new FormData();
    formData.set("intent", "delete");
    formData.set("poId", poToDelete.id);
    fetcher.submit(formData, { method: "post", action: "/app/purchase-orders?index" });
    setPoToDelete(null);
    setDeleteConfirmInput("");
  };

  const rows = filteredOrders.map((po) => {
    const totalValue = po.lines.reduce((sum, l) => {
      const cost = parseFloat(l.unitCost ?? "0") || 0;
      return sum + cost * l.orderedQty;
    }, 0);
    const canDelete = ["DRAFT", "CANCELED", "RECEIVED"].includes(po.status);
    const canReceive = ["ORDERED", "PARTIALLY_RECEIVED"].includes(po.status);
    const pendingQty = po.lines.reduce((s, l) => s + Math.max(0, l.orderedQty - l.receivedQty), 0);
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
      formatStatusDate(po),
      <InlineStack key={po.id} gap="200" blockAlign="center" align="end" wrap={false} style={{ justifyContent: "flex-end" }}>
        {canReceive && (
          <Link
            to={`/app/purchase-orders/${po.id}/receive`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "4px 12px",
              background: "var(--p-color-bg-fill-secondary)",
              color: "var(--p-color-text)",
              borderRadius: "var(--p-border-radius-200)",
              fontSize: "var(--p-font-size-200)",
              fontWeight: 500,
              textDecoration: "none",
            }}
          >
            Receive{pendingQty > 0 ? ` (${pendingQty})` : ""}
          </Link>
        )}
        {canDelete ? (
          <Button
            icon={DeleteIcon}
            variant="plain"
            tone="critical"
            size="slim"
            accessibilityLabel="Delete PO"
            onClick={() => setPoToDelete({ id: po.id, label: formatPoDisplayNumber(po.poNumber), status: po.status })}
          />
        ) : (
          <Tooltip content="Can only delete draft, canceled, or received purchase orders">
            <Button
              icon={DeleteIcon}
              variant="plain"
              tone="critical"
              size="slim"
              accessibilityLabel="Delete PO"
              disabled
            />
          </Tooltip>
        )}
      </InlineStack>,
    ];
  });

  return (
    <PageShell
      title="Purchase Orders"
      primaryAction={{ content: "Create purchase order", url: "/app/purchase-orders/new" }}
      secondaryActions={[{ content: "View deleted", url: "/app/purchase-orders/deleted" }]}
    >
      <Modal
        open={!!poToDelete}
        onClose={() => { setPoToDelete(null); setDeleteConfirmInput(""); }}
        title="Delete purchase order"
        primaryAction={{
          content: "Delete",
          destructive: true,
          onAction: handleDeleteConfirm,
          loading: fetcher.state !== "idle",
          disabled: isReceivedDelete && !canConfirmReceivedDelete,
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => { setPoToDelete(null); setDeleteConfirmInput(""); } }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {isReceivedDelete ? (
              <>
                <p>
                  Only delete if this order was a mistake. This will remove the purchase order from your records and undo the stock changes made when receiving (quantities will be reduced in Shopify).
                </p>
                <p>
                  The PO will be moved to Deleted and kept for your records.
                </p>
                <TextField
                  label={`Type "${poToDelete?.label ?? ""}" to confirm`}
                  value={deleteConfirmInput}
                  onChange={setDeleteConfirmInput}
                  placeholder={poToDelete?.label ?? ""}
                  autoComplete="off"
                />
              </>
            ) : (
              <p>
                This will remove {poToDelete ? poToDelete.label : ""} from the main list. It will be kept in Deleted for your records.
              </p>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
      <BlockStack gap="400">
        {orders.length === 0 ? (
          <Card>
            <EmptyState
              heading="No purchase orders yet"
              action={{
                content: "Create purchase order",
                url: "/app/purchase-orders/new",
              }}
              secondaryAction={{
                content: "View reorder suggestions",
                url: "/app/reorder",
              }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>Create a purchase order from the Reorder screen by clicking &quot;Add to PO&quot; on items you need to restock, or create an empty PO and add lines manually.</p>
              <p>
                <Button url="/app/purchase-orders/deleted">View deleted purchase orders</Button>
              </p>
            </EmptyState>
          </Card>
        ) : (
          <Card>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 16, flexWrap: "wrap" }}>
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
              <InlineStack gap="200">
                <Button url="/app/purchase-orders/deleted">View deleted</Button>
                <Button variant="primary" url="/app/purchase-orders/new">
                  Create purchase order
                </Button>
              </InlineStack>
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
                headings={["PO", "Supplier", "Lines", "Total Qty", "Total Value", "Status", "Last updated", ""]}
                rows={rows}
              />
            )}
          </Card>
        )}
      </BlockStack>
    </PageShell>
  );
}
