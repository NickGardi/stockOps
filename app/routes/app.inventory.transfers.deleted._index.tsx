import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link, useLoaderData, useFetcher } from "@remix-run/react";
import { useState } from "react";
import {
  Card,
  DataTable,
  BlockStack,
  Badge,
  EmptyState,
  Button,
  Banner,
  TextField,
  Box,
} from "@shopify/polaris";
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { transfers: [] };

  const transfers = await prisma.stockTransfer.findMany({
    where: { shopId: shop.id, deletedAt: { not: null } },
    include: {
      sourceLocation: true,
      destLocation: true,
      lines: true,
    },
    orderBy: { deletedAt: "desc" },
  });

  return { transfers };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return json({ error: "Shop not found" }, { status: 404 });

  const formData = await request.formData();
  if (formData.get("intent") !== "restore") return json({ error: "Invalid intent" }, { status: 400 });
  const transferId = String(formData.get("transferId") || "").trim();
  if (!transferId) return json({ error: "Transfer ID required" }, { status: 400 });

  const { restoreTransfer } = await import("../services/stock-transfer.server");
  const result = await restoreTransfer(admin, shop.id, transferId);
  if (!result.success) {
    return json({ error: result.error ?? "Failed to restore transfer" }, { status: 500 });
  }

  const params = new URLSearchParams({
    toast: result.message ?? "Transfer restored.",
    toastTone: "success",
  });
  return redirect(`/app/inventory/transfers/${transferId}?${params.toString()}`);
};

function formatDate(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function DeletedTransfersList() {
  const { transfers } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ error?: string }>();
  const [searchQuery, setSearchQuery] = useState("");

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

  const rows = filteredTransfers.map((t) => [
    <Link key={t.id} to={`/app/inventory/transfers/${t.id}`}>
      {formatTransferDisplayNumber(t.transferNumber)}
    </Link>,
    t.sourceLocation.name,
    t.destLocation.name,
    t.lines.reduce((sum, l) => sum + l.quantity, 0),
    <Badge key={`status-${t.id}`} tone={STATUS_TONE[t.status] ?? "info"}>
      {t.status.replace(/_/g, " ")}
    </Badge>,
    formatDate(t.deletedAt),
    <fetcher.Form key={`restore-${t.id}`} method="post" style={{ display: "inline" }}>
      <input type="hidden" name="intent" value="restore" />
      <input type="hidden" name="transferId" value={t.id} />
      <Button size="slim" submit loading={fetcher.state !== "idle"} disabled={fetcher.state !== "idle"}>
        Restore
      </Button>
    </fetcher.Form>,
  ]);

  const error = fetcher.data?.error ?? null;

  return (
    <PageShell
      title="Deleted transfers"
      backAction={{ url: "/app/inventory/transfers" }}
      primaryAction={{ content: "Back to transfers", url: "/app/inventory/transfers" }}
    >
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" onDismiss={() => {}}>
            {error}
          </Banner>
        )}
        {transfers.length === 0 ? (
          <Card>
            <EmptyState
              heading="No deleted transfers"
              action={{ content: "Back to transfers", url: "/app/inventory/transfers" }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>Deleted transfers are kept here for your records. They never appear on the main list.</p>
            </EmptyState>
          </Card>
        ) : (
          <Card>
            <BlockStack gap="400">
              <p style={{ margin: 0, color: "var(--p-color-text-subdued)", fontSize: "var(--p-font-size-200)" }}>
                These transfers were removed from the main list but are kept for your records. Restoring a sent or
                completed transfer will re-apply inventory changes in Shopify.
              </p>
              <Box maxWidth="320px">
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
              {filteredTransfers.length === 0 ? (
                <EmptyState
                  heading="No matching transfers"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>Try a different search term or clear the search.</p>
                </EmptyState>
              ) : (
                <DataTable
                  columnContentTypes={["text", "text", "text", "numeric", "text", "text", "text"]}
                  headings={["Transfer", "From", "To", "Units", "Status", "Deleted", ""]}
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
