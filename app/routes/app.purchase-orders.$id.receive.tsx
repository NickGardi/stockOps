import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useSearchParams } from "@remix-run/react";
import {
  Card,
  Button,
  BlockStack,
  Text,
  Banner,
  DataTable,
  InlineStack,
  Box,
} from "@shopify/polaris";
import { PageShell } from "../components/PageShell";
import { useState, useEffect } from "react";
import { randomUUID } from "node:crypto";
import { authenticate } from "../shopify.server";
import { receiveBatch, reconcileReceivedQty, syncReceivedFromShopify } from "../services/receiving.server";
import prisma from "../db.server";
import "../styles/receive.css";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
    include: { primaryWarehouseLocation: true },
  });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: params.id!, shopId: shop.id },
    include: {
      supplier: true,
      receivingLocation: true,
      lines: {
        include: { variant: { include: { product: true } } },
      },
    },
  });
  if (!po) throw new Response("Not found", { status: 404 });
  if (po.deletedAt) throw new Response("Cannot receive a deleted purchase order", { status: 403 });

  const locationId = po.receivingLocationId ?? shop.primaryWarehouseLocationId;
  const receivingLocation = po.receivingLocation ?? shop.primaryWarehouseLocation;

  return {
    po,
    receivingLocation,
    idempotencyKey: `receive-batch-${randomUUID()}`,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const adminClient = admin as Parameters<typeof syncReceivedFromShopify>[0];
  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
    select: { id: true },
  });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const formData = await request.formData();
  const intent = formData.get("intent");
  const idempotencyKey = String(formData.get("idempotencyKey") || "");

  if (intent === "batch") {
    const lineUpdates: Array<{ lineId: string; quantity: number }> = [];
    for (const [key, value] of formData.entries()) {
      if (key.startsWith("qty_") && value) {
        const lineId = key.slice(4);
        const qty = parseInt(String(value), 10);
        if (lineId && !Number.isNaN(qty) && qty > 0) {
          lineUpdates.push({ lineId, quantity: qty });
        }
      }
    }

    if (lineUpdates.length === 0) {
      return { success: false, error: "Enter at least one quantity to receive" };
    }
    if (!idempotencyKey) {
      return { success: false, error: "Missing idempotency key" };
    }

    const result = await receiveBatch(
      admin,
      shop.id,
      params.id!,
      lineUpdates,
      idempotencyKey
    );

    if (result.success && result.received > 0) {
      return json({ redirect: `/app/purchase-orders/${params.id}` });
    }
    if (!result.success) {
      return { success: false, error: result.error };
    }
  }

  if (intent === "reconcile") {
    const lineUpdates: Array<{ lineId: string; receivedQty: number }> = [];
    for (const [key, value] of formData.entries()) {
      if (key.startsWith("receivedQty_") && value !== "") {
        const lineId = key.slice(12);
        const receivedQty = parseInt(String(value), 10);
        if (lineId && !Number.isNaN(receivedQty) && receivedQty >= 0) {
          lineUpdates.push({ lineId, receivedQty });
        }
      }
    }
    if (lineUpdates.length === 0) {
      return { success: false, error: "Enter received quantities for at least one line" };
    }
    const result = await reconcileReceivedQty(shop.id, params.id!, lineUpdates);
    if (result.success) {
      return json({ redirect: `/app/purchase-orders/${params.id}` });
    }
    return { success: false, error: result.error };
  }

  if (intent === "syncFromShopify") {
    const result = await syncReceivedFromShopify(adminClient, shop.id, params.id!);
    if (result.success) {
      return json({ redirect: `/app/purchase-orders/${params.id}` });
    }
    return json({ success: false, error: result.error }, { status: 400 });
  }

  return { success: true };
};

export default function Receive() {
  const { po, receivingLocation, idempotencyKey } = useLoaderData<typeof loader>();
  const receiveFetcher = useFetcher<{ redirect?: string; success?: boolean; error?: string }>();
  const reconcileFetcher = useFetcher<{ redirect?: string; success?: boolean; error?: string }>();
  const syncFetcher = useFetcher<{ redirect?: string; success?: boolean; error?: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reconcileQuantities, setReconcileQuantities] = useState<Record<string, string>>({});
  const [selectedTab, setSelectedTab] = useState(searchParams.get("tab") === "reconcile" ? 1 : 0);

  const actionData = receiveFetcher.data ?? reconcileFetcher.data ?? syncFetcher.data;

  useEffect(() => {
    if (
      actionData?.redirect &&
      receiveFetcher.state === "idle" &&
      reconcileFetcher.state === "idle" &&
      syncFetcher.state === "idle"
    ) {
      navigate(actionData.redirect);
    }
  }, [actionData?.redirect, receiveFetcher.state, reconcileFetcher.state, syncFetcher.state, navigate]);

  const pendingLines = po.lines.filter((l) => l.orderedQty - l.receivedQty > 0);
  const allLines = po.lines.filter((l) => l.variant?.product != null);
  const canReceive = !!receivingLocation;

  const updateQty = (lineId: string, value: string) => {
    setQuantities((prev) => ({ ...prev, [lineId]: value }));
  };

  const updateReconcileQty = (lineId: string, value: string) => {
    setReconcileQuantities((prev) => ({ ...prev, [lineId]: value }));
  };

  const fillAllPending = () => {
    const next: Record<string, string> = {};
    for (const l of pendingLines) {
      next[l.id] = String(l.orderedQty - l.receivedQty);
    }
    setQuantities(next);
  };

  const rows = pendingLines.map((l) => {
    const pending = l.orderedQty - l.receivedQty;
    const qty = quantities[l.id] ?? String(pending);
    return [
      l.variant.product.title,
      l.variant.title,
      l.variant.sku || "—",
      l.orderedQty,
      l.receivedQty,
      pending,
      <input
        key={l.id}
        type="number"
        value={qty}
        onChange={(e) => updateQty(l.id, e.target.value)}
        min={0}
        max={pending}
        className="receive-qty-input"
        aria-label={`Receive quantity for ${l.variant?.product?.title}`}
      />,
    ];
  });

  const reconcileRows = allLines.map((l) => {
    const received = reconcileQuantities[l.id] ?? String(l.receivedQty);
    return [
      l.variant.product.title,
      l.variant.title,
      l.variant.sku || "—",
      l.orderedQty,
      <input
        key={l.id}
        type="number"
        value={received}
        onChange={(e) => updateReconcileQty(l.id, e.target.value)}
        min={0}
        max={l.orderedQty}
        className="receive-qty-input"
        aria-label={`Received quantity for ${l.variant?.product?.title}`}
      />,
    ];
  });

  const totalToReceive = pendingLines.reduce((sum, l) => {
    const v = quantities[l.id] ?? String(l.orderedQty - l.receivedQty);
    const n = parseInt(v, 10);
    return sum + (Number.isNaN(n) ? 0 : Math.max(0, Math.min(n, l.orderedQty - l.receivedQty)));
  }, 0);

  return (
    <PageShell
      title="Receive"
      backAction={{ onAction: () => navigate(`/app/purchase-orders/${po.id}`) }}
    >
      <div className="receive-page">
        {actionData?.success && (
          <Banner tone="success" onDismiss={() => {}}>
            Received successfully.
          </Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical" onDismiss={() => {}}>
            {actionData.error}
          </Banner>
        )}
        {!canReceive && (
          <Banner tone="critical" title="Receiving location not set">
            Select a location for this purchase order or in Settings.
          </Banner>
        )}
        {receivingLocation && (
          <Text as="p" variant="bodyMd" tone="subdued">
            Receiving into: {receivingLocation.name}
          </Text>
        )}
        <Card>
          <BlockStack gap="300">
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "var(--p-space-200)" }}>
              <InlineStack gap="200" wrap blockAlign="center">
                <Button
                  pressed={selectedTab === 0}
                  onClick={() => setSelectedTab(0)}
                  size="slim"
                >
                  Receive and sync
                </Button>
                <Button
                  pressed={selectedTab === 1}
                  onClick={() => setSelectedTab(1)}
                  size="slim"
                >
                  Reconcile only (no Shopify sync)
                </Button>
              </InlineStack>
              <Button
                onClick={fillAllPending}
                size="slim"
                type="button"
                disabled={selectedTab !== 0 || pendingLines.length === 0}
              >
                Fill all pending
              </Button>
            </div>
            {selectedTab === 0 && (
              <receiveFetcher.Form method="post">
                <input type="hidden" name="intent" value="batch" />
                <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
                {pendingLines.length === 0 ? (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    No lines with pending quantity.
                  </Text>
                ) : (
                  <>
                      <div className="receive-table-wrapper">
                        <DataTable
                          columnContentTypes={["text", "text", "text", "numeric", "numeric", "numeric", "text"]}
                          headings={["Product", "Variant", "SKU", "Ordered", "Received", "Pending", "Receive quantity"]}
                          rows={rows}
                        />
                      </div>
                      {pendingLines.map((l) => (
                        <input
                          key={l.id}
                          type="hidden"
                          name={`qty_${l.id}`}
                          value={quantities[l.id] ?? l.orderedQty - l.receivedQty}
                        />
                      ))}
                      <Box paddingBlockStart="300">
                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                          <Button
                            variant="primary"
                            submit
                            disabled={!canReceive || totalToReceive < 1 || pendingLines.length === 0}
                            loading={receiveFetcher.state !== "idle"}
                          >
                            Receive and sync ({totalToReceive} units)
                          </Button>
                        </div>
                      </Box>
                    </>
                  )}
              </receiveFetcher.Form>
            )}
            {selectedTab === 1 && (
              <BlockStack gap="300">
                <Text as="p" variant="bodyMd" tone="subdued">
                  Use this when you already updated stock in Shopify and need to fix purchase order tracking. Enter the total received quantity per line, or sync from current Shopify inventory.
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  <syncFetcher.Form method="post">
                    <input type="hidden" name="intent" value="syncFromShopify" />
                    <Button submit loading={syncFetcher.state !== "idle"}>
                      Sync from Shopify
                    </Button>
                  </syncFetcher.Form>
                  {syncFetcher.data && "error" in syncFetcher.data && (
                    <Text as="span" variant="bodyMd" tone="critical">
                      {syncFetcher.data.error}
                    </Text>
                  )}
                </InlineStack>
                <reconcileFetcher.Form method="post">
                  <input type="hidden" name="intent" value="reconcile" />
                  <div className="reconcile-table-wrapper">
                    <DataTable
                      columnContentTypes={["text", "text", "text", "numeric", "text"]}
                      headings={["Product", "Variant", "SKU", "Ordered", "Received quantity"]}
                      rows={reconcileRows}
                    />
                  </div>
                  {allLines.map((l) => (
                    <input
                      key={l.id}
                      type="hidden"
                      name={`receivedQty_${l.id}`}
                      value={reconcileQuantities[l.id] ?? l.receivedQty}
                    />
                  ))}
                  <Button
                    variant="primary"
                    submit
                    loading={reconcileFetcher.state !== "idle"}
                  >
                    Reconcile purchase order
                  </Button>
                </reconcileFetcher.Form>
              </BlockStack>
            )}
          </BlockStack>
        </Card>
        <Box padding="400">
          <Banner tone="info" title="Messed up?">
            If you already updated stock in Shopify and need to fix purchase order tracking, try <strong>Sync from Shopify</strong> first (one click). If that undercounts because you&apos;ve sold some stock, use the <strong>Reconcile only</strong> button to manually enter received quantities. Both update StockOps without touching Shopify.
          </Banner>
        </Box>
        <Box paddingBlockStart="400">
          <Card>
            <BlockStack gap="400">
              <Text as="h3" variant="headingMd" fontWeight="bold">
                Ideal flow
              </Text>
              <BlockStack gap="100">
                <Text as="p" variant="bodyMd" tone="subdued">1. Confirm the purchase order (ORDERED or PARTIALLY_RECEIVED).</Text>
                <Text as="p" variant="bodyMd" tone="subdued">2. When stock arrives, go to the Receive page.</Text>
                <Text as="p" variant="bodyMd" tone="subdued">3. Use <strong>Receive and sync</strong> – enter quantities and submit.</Text>
                <Text as="p" variant="bodyMd" tone="subdued">4. StockOps updates Shopify inventory and purchase order tracking, and marks the purchase order fully received when all lines are done.</Text>
              </BlockStack>
              <Text as="h3" variant="headingMd" fontWeight="bold">
                What can go wrong and how to fix it
              </Text>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" tone="subdued">
                  <strong>Receiving location not set</strong> – Set the receiving location on the purchase order or in Settings (primary warehouse).
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  <strong>Stock updated in Shopify but not in StockOps</strong> – Use <strong>Sync from Shopify</strong> if current Shopify inventory still reflects what was received (no sales yet).
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  <strong>Stock updated in Shopify but some has been sold</strong> – Use <strong>Reconcile</strong> to manually enter received quantities. Sync would undercount because it uses current available stock.
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  <strong>Need to mark purchase order fully received even though Shopify shows less</strong> – Use <strong>Reconcile</strong> to enter the actual received quantities (e.g. 50 received, 20 sold → enter 50).
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  <strong>Variant has no Shopify inventory item</strong> – Run Resync in Settings to link variants to Shopify.
                </Text>
              </BlockStack>
              <Text as="h3" variant="headingMd" fontWeight="bold">
                When to use each tool
              </Text>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" tone="subdued">
                  <strong>Receive and sync</strong> – Normal receiving: stock arrives and you record it here. Updates both Shopify and StockOps.
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  <strong>Sync from Shopify</strong> – Shopify inventory is correct, StockOps purchase order tracking is wrong, and current stock still reflects what was received.
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  <strong>Reconcile</strong> – Correct StockOps purchase order tracking without changing Shopify, or when Sync would undercount (e.g. some stock already sold).
                </Text>
              </BlockStack>
            </BlockStack>
          </Card>
        </Box>
      </div>
    </PageShell>
  );
}
