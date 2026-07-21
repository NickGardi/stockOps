import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import { useState } from "react";
import {
  Card,
  BlockStack,
  Button,
  DataTable,
  Badge,
  EmptyState,
  TextField,
  Box,
  InlineStack,
  Banner,
  Modal,
  Tooltip,
} from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { PageShell } from "../components/PageShell";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { formatTransferDisplayNumber } from "../lib/format-po";

const STATUS_TONE: Record<string, "info" | "success" | "warning" | "critical"> = {
  DRAFT: "info",
  IN_TRANSIT: "warning",
  RECEIVED: "success",
  CANCELED: "critical",
};

function getDeleteModalBody(transfer: {
  sentAt: Date | string | null;
  receivedAt: Date | string | null;
  sourceLocation: { name: string };
  destLocation: { name: string };
  lines: { quantity: number }[];
}): string {
  const totalUnits = transfer.lines.reduce((sum, l) => sum + l.quantity, 0);
  if (transfer.receivedAt) {
    return `This will move the transfer to Deleted and reverse it in Shopify: remove ${totalUnits} unit${totalUnits === 1 ? "" : "s"} from ${transfer.destLocation.name} and restore them to ${transfer.sourceLocation.name}.`;
  }
  if (transfer.sentAt) {
    return `This will move the transfer to Deleted and return ${totalUnits} unit${totalUnits === 1 ? "" : "s"} to ${transfer.sourceLocation.name} in Shopify.`;
  }
  return "This will remove the transfer from the main list. It will be kept in Deleted for your records. No inventory will change in Shopify.";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { transfers: [], toast: null as string | null, toastTone: "success" as const };

  const transfers = await prisma.stockTransfer.findMany({
    where: { shopId: shop.id, deletedAt: null },
    include: {
      sourceLocation: true,
      destLocation: true,
      lines: { include: { variant: { include: { product: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });

  const url = new URL(request.url);
  const toast = url.searchParams.get("toast");
  const toastTone = url.searchParams.get("toastTone") === "critical" ? "critical" : "success";

  return { transfers, toast, toastTone };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return json({ error: "Shop not found" }, { status: 404 });

  const formData = await request.formData();
  if (formData.get("intent") !== "delete") return json({ error: "Invalid intent" }, { status: 400 });
  const transferId = String(formData.get("transferId") || "").trim();
  if (!transferId) return json({ error: "Transfer ID required" }, { status: 400 });

  const transfer = await prisma.stockTransfer.findFirst({
    where: { id: transferId, shopId: shop.id, deletedAt: null },
    include: {
      sourceLocation: true,
      destLocation: true,
      lines: true,
    },
  });
  if (!transfer) return json({ error: "Transfer not found" }, { status: 404 });

  if (!["DRAFT", "CANCELED", "IN_TRANSIT", "RECEIVED"].includes(transfer.status)) {
    return json({ error: "Cannot delete transfer in this status" }, { status: 400 });
  }

  const { deleteTransfer } = await import("../services/stock-transfer.server");
  const result = await deleteTransfer(admin, shop.id, transferId);
  if (!result.success) {
    return json({ error: result.error ?? "Failed to delete transfer" }, { status: 500 });
  }

  return json({ success: true, message: result.message });
};

export default function TransfersList() {
  const { transfers, toast, toastTone } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const fetcher = useFetcher<{ error?: string; success?: boolean; message?: string }>();
  const [searchQuery, setSearchQuery] = useState("");
  const [dismissedToast, setDismissedToast] = useState(false);
  const [transferToDelete, setTransferToDelete] = useState<{
    id: string;
    label: string;
    status: string;
    sourceName: string;
    destName: string;
    totalUnits: number;
  } | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");

  const filteredTransfers = searchQuery.trim()
    ? transfers.filter((t) => {
        const q = searchQuery.trim().toLowerCase();
        const transferLabel = formatTransferDisplayNumber(t.transferNumber).toLowerCase();
        const source = t.sourceLocation.name.toLowerCase();
        const dest = t.destLocation.name.toLowerCase();
        const status = t.status.toLowerCase().replace(/_/g, " ");
        return transferLabel.includes(q) || source.includes(q) || dest.includes(q) || status.includes(q);
      })
    : transfers;

  const deleteTransferRecord = transferToDelete
    ? transfers.find((t) => t.id === transferToDelete.id)
    : null;

  const needsTypedConfirm = !!(deleteTransferRecord?.sentAt);
  const canConfirmDelete =
    !needsTypedConfirm || deleteConfirmInput.trim() === (transferToDelete?.label ?? "");

  const handleDeleteConfirm = () => {
    if (!transferToDelete || !canConfirmDelete) return;
    const formData = new FormData();
    formData.set("intent", "delete");
    formData.set("transferId", transferToDelete.id);
    fetcher.submit(formData, { method: "post" });
    setTransferToDelete(null);
    setDeleteConfirmInput("");
  };

  const listToast = fetcher.data?.success ? fetcher.data.message : null;
  const listError = fetcher.data?.error ?? null;

  const rows = filteredTransfers.map((t) => {
    const totalUnits = t.lines.reduce((sum, l) => sum + l.quantity, 0);
    const canDelete = ["DRAFT", "CANCELED", "IN_TRANSIT", "RECEIVED"].includes(t.status);
    const label = formatTransferDisplayNumber(t.transferNumber);

    return [
      <Link key={`link-${t.id}`} to={`/app/inventory/transfers/${t.id}`}>
        {label}
      </Link>,
      t.sourceLocation.name,
      t.destLocation.name,
      totalUnits,
      <Badge key={`status-${t.id}`} tone={STATUS_TONE[t.status] ?? "info"}>
        {t.status.replace(/_/g, " ")}
      </Badge>,
      t.sentAt ? new Date(t.sentAt).toLocaleDateString() : "—",
      <InlineStack key={`actions-${t.id}`} gap="200" blockAlign="center" wrap={false}>
        <Button variant="plain" size="slim" onClick={() => navigate(`/app/inventory/transfers/${t.id}`)}>
          View
        </Button>
        {canDelete ? (
          <Button
            icon={DeleteIcon}
            variant="plain"
            tone="critical"
            size="slim"
            accessibilityLabel="Delete transfer"
            onClick={() =>
              setTransferToDelete({
                id: t.id,
                label,
                status: t.status,
                sourceName: t.sourceLocation.name,
                destName: t.destLocation.name,
                totalUnits,
              })
            }
          />
        ) : (
          <Tooltip content="Cannot delete transfer in this status">
            <Button
              icon={DeleteIcon}
              variant="plain"
              tone="critical"
              size="slim"
              accessibilityLabel="Delete transfer"
              disabled
            />
          </Tooltip>
        )}
      </InlineStack>,
    ];
  });

  return (
    <PageShell
      title="Stock Transfers"
      primaryAction={{ content: "New transfer", url: "/app/inventory/transfers/new" }}
      secondaryActions={[{ content: "View deleted", url: "/app/inventory/transfers/deleted" }]}
    >
      <Modal
        open={!!transferToDelete}
        onClose={() => {
          setTransferToDelete(null);
          setDeleteConfirmInput("");
        }}
        title="Delete transfer"
        primaryAction={{
          content: needsTypedConfirm ? "Delete and update Shopify" : "Delete",
          destructive: true,
          onAction: handleDeleteConfirm,
          loading: fetcher.state !== "idle",
          disabled: !canConfirmDelete,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => {
              setTransferToDelete(null);
              setDeleteConfirmInput("");
            },
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {deleteTransferRecord && <p>{getDeleteModalBody(deleteTransferRecord)}</p>}
            {needsTypedConfirm && transferToDelete && (
              <TextField
                label={`Type "${transferToDelete.label}" to confirm`}
                value={deleteConfirmInput}
                onChange={setDeleteConfirmInput}
                placeholder={transferToDelete.label}
                autoComplete="off"
              />
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>

      {toast && !dismissedToast && (
        <Banner tone={toastTone} onDismiss={() => setDismissedToast(true)}>
          {toast}
        </Banner>
      )}
      {listToast && (
        <Banner tone="success" onDismiss={() => {}}>
          {listToast}
        </Banner>
      )}
      {listError && (
        <Banner tone="critical" onDismiss={() => {}}>
          {listError}
        </Banner>
      )}

      <Card>
        {transfers.length === 0 ? (
          <EmptyState
            heading="No transfers yet"
            action={{
              content: "Create transfer",
              url: "/app/inventory/transfers/new",
            }}
            secondaryAction={{
              content: "View deleted transfers",
              url: "/app/inventory/transfers/deleted",
            }}
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>Move inventory between locations.</p>
          </EmptyState>
        ) : (
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center" gap="400" wrap={false}>
              <Box minWidth="200px" maxWidth="320px">
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
                <Button url="/app/inventory/transfers/deleted">View deleted</Button>
                <Button variant="primary" url="/app/inventory/transfers/new">
                  New transfer
                </Button>
              </InlineStack>
            </InlineStack>
            {filteredTransfers.length === 0 ? (
              <EmptyState
                heading="No matching transfers"
                action={{
                  content: "Clear search",
                  onAction: () => setSearchQuery(""),
                }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Try a different search term.</p>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "numeric", "text", "text", "text"]}
                headings={["Transfer", "From", "To", "Units", "Status", "Sent", ""]}
                rows={rows}
              />
            )}
          </BlockStack>
        )}
      </Card>
    </PageShell>
  );
}
