import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useLoaderData,
  useNavigation,
  useActionData,
  useFetcher,
  Form,
} from "@remix-run/react";
import { useState, useEffect } from "react";
import {
  Card,
  DataTable,
  Button,
  BlockStack,
  Text,
  InlineStack,
  Badge,
  TextField,
  FormLayout,
  Select,
  Banner,
  Modal,
} from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { PageShell } from "../components/PageShell";
import { authenticate } from "../shopify.server";
import { formatTransferDisplayNumber } from "../lib/format-po";
import { AddTransferLinesModal } from "../components/AddTransferLinesModal";
import prisma from "../db.server";

const STATUS_TONE: Record<string, "info" | "success" | "warning" | "critical"> = {
  DRAFT: "info",
  IN_TRANSIT: "warning",
  RECEIVED: "success",
  CANCELED: "critical",
};

function redirectWithToast(path: string, message: string, tone: "success" | "critical" = "success") {
  const params = new URLSearchParams({ toast: message, toastTone: tone });
  return redirect(`${path}?${params.toString()}`);
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const transfer = await prisma.stockTransfer.findFirst({
    where: { id: params.id!, shopId: shop.id },
    include: {
      sourceLocation: true,
      destLocation: true,
      lines: {
        include: { variant: { include: { product: true } } },
      },
    },
  });
  if (!transfer) throw new Response("Not found", { status: 404 });

  let variantOptionsForAdd: { id: string; productTitle: string; variantTitle: string; sku: string | null; availableAtSource: number }[] = [];
  if (transfer.status === "DRAFT" && !transfer.deletedAt) {
    const variantsWithStock = await prisma.variant.findMany({
      where: {
        shopId: shop.id,
        inventoryTracked: true,
        inventoryLevels: {
          some: {
            locationId: transfer.sourceLocationId,
            available: { gt: 0 },
          },
        },
      },
      include: {
        product: true,
        inventoryLevels: {
          where: { locationId: transfer.sourceLocationId },
          take: 1,
        },
      },
      orderBy: [{ product: { title: "asc" } }, { title: "asc" }],
      take: 500,
    });
    variantOptionsForAdd = variantsWithStock.map((v) => ({
      id: v.id,
      productTitle: v.product.title,
      variantTitle: v.title,
      sku: v.sku,
      availableAtSource: v.inventoryLevels[0]?.available ?? 0,
    }));
  }

  const url = new URL(request.url);
  const toast = url.searchParams.get("toast");
  const toastTone = url.searchParams.get("toastTone") === "critical" ? "critical" : "success";

  return { transfer, variantOptionsForAdd, toast, toastTone };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const transfer = await prisma.stockTransfer.findFirst({
    where: { id: params.id!, shopId: shop.id },
  });
  if (!transfer) throw new Response("Not found", { status: 404 });

  const formData = await request.formData();
  const intent = formData.get("intent");
  const transferPath = `/app/inventory/transfers/${transfer.id}`;

  if (intent === "restore") {
    if (!transfer.deletedAt) return json({ success: false, error: "Transfer is not deleted" }, { status: 400 });
    const { restoreTransfer } = await import("../services/stock-transfer.server");
    const result = await restoreTransfer(admin, shop.id, transfer.id);
    if (!result.success) return json({ success: false, error: result.error ?? "Failed to restore transfer" });
    return redirectWithToast(transferPath, result.message ?? "Transfer restored.");
  }

  if (transfer.deletedAt) {
    return json({ success: false, error: "Cannot edit a deleted transfer" }, { status: 403 });
  }

  if (intent === "send") {
    const { sendTransfer } = await import("../services/stock-transfer.server");
    const result = await sendTransfer(admin, shop.id, transfer.id);
    if (!result.success) return json({ success: false, error: result.error ?? "Failed to send" });
    return redirectWithToast(transferPath, result.message ?? "Transfer sent.");
  }

  if (intent === "receive") {
    const { receiveTransfer } = await import("../services/stock-transfer.server");
    const result = await receiveTransfer(admin, shop.id, transfer.id);
    if (!result.success) return json({ success: false, error: result.error ?? "Failed to receive" });
    return redirectWithToast(transferPath, result.message ?? "Transfer received.");
  }

  if (intent === "delete" || intent === "cancel") {
    const { deleteTransfer } = await import("../services/stock-transfer.server");
    const result = await deleteTransfer(admin, shop.id, transfer.id);
    if (!result.success) return json({ success: false, error: result.error ?? "Failed to delete transfer" });
    return redirectWithToast("/app/inventory/transfers", result.message ?? "Transfer deleted.");
  }

  if (intent === "bulkAddTransferLines" && transfer.status === "DRAFT" && !transfer.deletedAt) {
    const payloadJson = formData.get("payload");
    const payload = payloadJson ? (JSON.parse(String(payloadJson)) as Array<{ variantId: string; quantity: number }>) : [];
    for (const { variantId, quantity } of payload) {
      if (!variantId || quantity < 1) continue;
      const variant = await prisma.variant.findFirst({
        where: { id: variantId, shopId: shop.id },
      });
      if (!variant) continue;
      await prisma.stockTransferLine.upsert({
        where: {
          stockTransferId_variantId: { stockTransferId: transfer.id, variantId },
        },
        create: {
          stockTransferId: transfer.id,
          variantId,
          quantity,
        },
        update: { quantity: { increment: quantity } },
      });
    }
    return redirect(transferPath);
  }

  if (intent === "deleteLine" && transfer.status === "DRAFT" && !transfer.deletedAt) {
    const lineId = String(formData.get("lineId") || "").trim();
    if (!lineId) return redirect(transferPath);
    const line = await prisma.stockTransferLine.findFirst({
      where: { id: lineId, stockTransferId: transfer.id },
    });
    if (line) {
      await prisma.stockTransferLine.delete({ where: { id: lineId } });
    }
    return redirect(transferPath);
  }

  if (intent === "updateMetadata" && transfer.status === "DRAFT" && !transfer.deletedAt) {
    const notes = String(formData.get("notes") || "").trim() || null;
    const reasonCode = String(formData.get("reasonCode") || "").trim() || null;
    await prisma.stockTransfer.update({
      where: { id: transfer.id },
      data: { notes, reasonCode },
    });
  }

  return redirect(transferPath);
};

const REASON_OPTIONS = [
  { label: "None", value: "" },
  { label: "Restock", value: "Restock" },
  { label: "Store transfer", value: "Store transfer" },
  { label: "Return", value: "Return" },
  { label: "Other", value: "Other" },
];

function getStatusBanner(transfer: {
  status: string;
  sourceLocation: { name: string };
  destLocation: { name: string };
  lines: { quantity: number }[];
}): { tone: "info" | "success" | "warning"; title: string; body: string } | null {
  const totalUnits = transfer.lines.reduce((sum, l) => sum + l.quantity, 0);
  if (transfer.status === "DRAFT") {
    return {
      tone: "info",
      title: "Inventory not moved yet",
      body: `Add products, then click Send to deduct ${totalUnits > 0 ? `${totalUnits} units ` : ""}from ${transfer.sourceLocation.name} in Shopify. Click Receive at the destination to add stock to ${transfer.destLocation.name}.`,
    };
  }
  if (transfer.status === "IN_TRANSIT") {
    return {
      tone: "warning",
      title: "In transit",
      body: `${totalUnits} unit${totalUnits === 1 ? "" : "s"} already deducted from ${transfer.sourceLocation.name} in Shopify. Click Receive to add them to ${transfer.destLocation.name}.`,
    };
  }
  if (transfer.status === "RECEIVED") {
    return {
      tone: "success",
      title: "Transfer complete",
      body: `${totalUnits} unit${totalUnits === 1 ? "" : "s"} moved from ${transfer.sourceLocation.name} to ${transfer.destLocation.name} in Shopify.`,
    };
  }
  return null;
}

function getDeleteModalCopy(transfer: {
  sentAt: Date | string | null;
  receivedAt: Date | string | null;
  sourceLocation: { name: string };
  destLocation: { name: string };
  lines: { quantity: number }[];
}): string {
  const totalUnits = transfer.lines.reduce((sum, l) => sum + l.quantity, 0);
  if (transfer.receivedAt) {
    return `Delete this completed transfer? This will reverse the move in Shopify and move it to Deleted: remove ${totalUnits} unit${totalUnits === 1 ? "" : "s"} from ${transfer.destLocation.name} and restore them to ${transfer.sourceLocation.name}.`;
  }
  if (transfer.sentAt) {
    return `Delete this transfer and return ${totalUnits} unit${totalUnits === 1 ? "" : "s"} to ${transfer.sourceLocation.name} in Shopify? It will move to Deleted.`;
  }
  return "Delete this transfer? It will move to Deleted. No inventory has been moved in Shopify.";
}

export default function TransferDetail() {
  const { transfer, variantOptionsForAdd = [], toast, toastTone } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const actionData = useActionData<{ success?: boolean; error?: string }>();
  const deleteFetcher = useFetcher();
  const restoreFetcher = useFetcher();
  const metadataFetcher = useFetcher();
  const [notes, setNotes] = useState(transfer.notes ?? "");
  const [reasonCode, setReasonCode] = useState(transfer.reasonCode ?? "");
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [dismissedToast, setDismissedToast] = useState(false);

  const isDeleted = !!transfer.deletedAt;

  useEffect(() => {
    setNotes(transfer.notes ?? "");
    setReasonCode(transfer.reasonCode ?? "");
    setDismissedToast(false);
  }, [transfer.notes, transfer.reasonCode, transfer.id]);

  const totalUnits = transfer.lines.reduce((sum, l) => sum + l.quantity, 0);
  const statusBanner = !isDeleted ? getStatusBanner(transfer) : null;
  const canDelete = !isDeleted && ["DRAFT", "IN_TRANSIT", "RECEIVED", "CANCELED"].includes(transfer.status);
  const isDeleting = deleteFetcher.state !== "idle";
  const isRestoring = restoreFetcher.state !== "idle";

  const handleDeleteConfirm = () => {
    const formData = new FormData();
    formData.set("intent", "delete");
    deleteFetcher.submit(formData, { method: "post" });
    setDeleteModalOpen(false);
  };

  const handleRestore = () => {
    const formData = new FormData();
    formData.set("intent", "restore");
    restoreFetcher.submit(formData, { method: "post" });
  };

  const rows = transfer.lines.map((l) => [
    l.variant.product.title,
    l.variant.title,
    l.variant.sku || "—",
    l.quantity,
    transfer.status === "DRAFT" && !isDeleted ? (
      <Form key={l.id} method="post" style={{ display: "inline-flex" }}>
        <input type="hidden" name="intent" value="deleteLine" />
        <input type="hidden" name="lineId" value={l.id} />
        <Button
          icon={DeleteIcon}
          variant="plain"
          tone="critical"
          size="slim"
          submit
          accessibilityLabel="Delete line"
        />
      </Form>
    ) : (
      ""
    ),
  ]);

  const canSend = !isDeleted && transfer.status === "DRAFT" && transfer.lines.length > 0;
  const canReceive = !isDeleted && transfer.status === "IN_TRANSIT";
  const [addProductsModalOpen, setAddProductsModalOpen] = useState(false);

  return (
    <PageShell
      title={formatTransferDisplayNumber(transfer.transferNumber)}
      backAction={{ url: isDeleted ? "/app/inventory/transfers/deleted" : "/app/inventory/transfers" }}
    >
      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete transfer"
        primaryAction={{
          content: transfer.status === "DRAFT" ? "Delete transfer" : "Delete and reverse inventory",
          destructive: true,
          onAction: handleDeleteConfirm,
          loading: isDeleting,
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setDeleteModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">{getDeleteModalCopy(transfer)}</Text>
            {transfer.status !== "DRAFT" && (
              <Text as="p" tone="subdued">
                Shopify inventory will be updated immediately. This cannot be undone from this screen.
              </Text>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>

      <BlockStack gap="400">
        {toast && !dismissedToast && (
          <Banner tone={toastTone} onDismiss={() => setDismissedToast(true)}>
            {toast}
          </Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical" onDismiss={() => {}}>
            {actionData.error}
          </Banner>
        )}
        {isDeleted && (
          <Banner
            title="This transfer was deleted"
            tone="warning"
            action={{ content: "Restore", onAction: handleRestore, loading: isRestoring }}
          >
            <p>
              It is kept for your records. You can view details but cannot edit, send, or receive.
              Restoring will move it back to the main list
              {transfer.status === "IN_TRANSIT" || transfer.status === "RECEIVED"
                ? " and re-apply inventory changes in Shopify"
                : ""}
              .
            </p>
          </Banner>
        )}
        {statusBanner && (
          <Banner tone={statusBanner.tone} title={statusBanner.title}>
            <p>{statusBanner.body}</p>
          </Banner>
        )}

        <Card>
          <BlockStack gap="200">
            {transfer.status === "DRAFT" && !isDeleted && (
              <Button onClick={() => setAddProductsModalOpen(true)}>
                Select products to add
              </Button>
            )}
            {transfer.lines.length === 0 ? (
              <Text as="p" variant="bodyMd" tone="subdued">
                No lines. Add variants to transfer.
              </Text>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "numeric", "text"]}
                headings={["Product", "Variant", "SKU", "Quantity", ""]}
                rows={rows}
              />
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <InlineStack gap="300" blockAlign="center">
              <Text as="h2" variant="headingMd">
                {formatTransferDisplayNumber(transfer.transferNumber)}: {transfer.sourceLocation.name} → {transfer.destLocation.name}
              </Text>
              <Badge tone={STATUS_TONE[transfer.status] ?? "info"}>
                {transfer.status.replace(/_/g, " ")}
              </Badge>
            </InlineStack>
            {transfer.sentAt && (
              <Text as="p" variant="bodyMd" tone="subdued">
                Sent: {new Date(transfer.sentAt).toLocaleDateString()}
              </Text>
            )}
            {transfer.receivedAt && (
              <Text as="p" variant="bodyMd" tone="subdued">
                Received: {new Date(transfer.receivedAt).toLocaleDateString()}
              </Text>
            )}
            {(transfer.notes || transfer.reasonCode) && (
              <BlockStack gap="100">
                {transfer.reasonCode && (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Reason: {transfer.reasonCode}
                  </Text>
                )}
                {transfer.notes && (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Notes: {transfer.notes}
                  </Text>
                )}
              </BlockStack>
            )}
            {transfer.status === "DRAFT" && !isDeleted && (
              <metadataFetcher.Form method="post">
                <input type="hidden" name="intent" value="updateMetadata" />
                <input type="hidden" name="notes" value={notes} />
                <input type="hidden" name="reasonCode" value={reasonCode} />
                <FormLayout>
                  <Select
                    label="Reason"
                    options={REASON_OPTIONS}
                    value={reasonCode}
                    onChange={setReasonCode}
                  />
                  <TextField
                    label="Notes"
                    value={notes}
                    onChange={setNotes}
                    multiline={2}
                    autoComplete="off"
                  />
                  <Button submit size="slim" loading={metadataFetcher.state !== "idle"}>
                    Save details
                  </Button>
                </FormLayout>
              </metadataFetcher.Form>
            )}
            <InlineStack gap="300">
              {canSend && (
                <Form method="post">
                  <input type="hidden" name="intent" value="send" />
                  <Button submit loading={navigation.state !== "idle"}>
                    Send — deduct from {transfer.sourceLocation.name}
                  </Button>
                </Form>
              )}
              {canReceive && (
                <Form method="post">
                  <input type="hidden" name="intent" value="receive" />
                  <Button variant="primary" submit loading={navigation.state !== "idle"}>
                    Receive — add to {transfer.destLocation.name}
                  </Button>
                </Form>
              )}
              {canDelete && (
                <Button variant="critical" onClick={() => setDeleteModalOpen(true)} loading={isDeleting}>
                  Delete transfer
                </Button>
              )}
            </InlineStack>
            {canSend && totalUnits > 0 && (
              <Text as="p" variant="bodySm" tone="subdued">
                Sending will reduce available inventory by {totalUnits} unit{totalUnits === 1 ? "" : "s"} at {transfer.sourceLocation.name} in Shopify.
              </Text>
            )}
            {canReceive && totalUnits > 0 && (
              <Text as="p" variant="bodySm" tone="subdued">
                Receiving will increase available inventory by {totalUnits} unit{totalUnits === 1 ? "" : "s"} at {transfer.destLocation.name} in Shopify.
              </Text>
            )}
          </BlockStack>
        </Card>

        <AddTransferLinesModal
          open={addProductsModalOpen}
          onClose={() => setAddProductsModalOpen(false)}
          onSuccess={() => setAddProductsModalOpen(false)}
          variants={variantOptionsForAdd}
          actionUrl={`/app/inventory/transfers/${transfer.id}`}
        />
      </BlockStack>
    </PageShell>
  );
}
