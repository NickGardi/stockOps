import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { useCallback, useState } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  ChoiceList,
  DataTable,
  EmptyState,
  Filters,
  InlineStack,
  Text,
} from "@shopify/polaris";
import { PageShell } from "../components/PageShell";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getInventoryRows,
  type InventoryStatus,
} from "../services/inventory.server";

const STATUS_TONE: Record<InventoryStatus, "success" | "warning" | "critical" | "attention"> = {
  IN_STOCK: "success",
  LOW: "warning",
  OUT: "critical",
  OVERSTOCK: "attention",
};

const STATUS_LABEL: Record<InventoryStatus, string> = {
  IN_STOCK: "In stock",
  LOW: "Low",
  OUT: "Out of stock",
  OVERSTOCK: "Overstock",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) {
    return json({
      rows: [] as Awaited<ReturnType<typeof getInventoryRows>>,
      locations: [] as { id: string; name: string }[],
      filters: { search: "", locationId: "", status: "ALL" as const },
    });
  }

  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() || "";
  const locationId = url.searchParams.get("location")?.trim() || "";
  const statusParam = url.searchParams.get("status")?.trim() || "ALL";
  const status = (
    ["ALL", "IN_STOCK", "LOW", "OUT", "OVERSTOCK"].includes(statusParam)
      ? statusParam
      : "ALL"
  ) as InventoryStatus | "ALL";

  const [locations, rows] = await Promise.all([
    prisma.location.findMany({
      where: { shopId: shop.id, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    getInventoryRows(shop.id, {
      locationId: locationId || undefined,
      search: search || undefined,
      status,
      limit: 500,
    }),
  ]);

  return json({
    rows,
    locations,
    filters: { search, locationId, status },
  });
};

export default function InventoryIndex() {
  const { rows, locations, filters } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [queryValue, setQueryValue] = useState(filters.search);
  const [locationFilter, setLocationFilter] = useState<string[]>(
    filters.locationId ? [filters.locationId] : []
  );
  const [statusFilter, setStatusFilter] = useState<string[]>(
    filters.status !== "ALL" ? [filters.status] : []
  );

  const applyFilters = useCallback(
    (next: { search?: string; location?: string[]; status?: string[] }) => {
      const params = new URLSearchParams(searchParams);
      const search = next.search !== undefined ? next.search : queryValue;
      const locs = next.location !== undefined ? next.location : locationFilter;
      const statuses = next.status !== undefined ? next.status : statusFilter;

      if (search.trim()) params.set("search", search.trim());
      else params.delete("search");

      if (locs[0]) params.set("location", locs[0]);
      else params.delete("location");

      if (statuses[0]) params.set("status", statuses[0]);
      else params.delete("status");

      setSearchParams(params);
    },
    [searchParams, setSearchParams, queryValue, locationFilter, statusFilter]
  );

  const handleQueryChange = (value: string) => {
    setQueryValue(value);
  };

  const handleQueryClear = () => {
    setQueryValue("");
    applyFilters({ search: "" });
  };

  const handleLocationChange = (value: string[]) => {
    setLocationFilter(value);
    applyFilters({ location: value });
  };

  const handleStatusChange = (value: string[]) => {
    setStatusFilter(value);
    applyFilters({ status: value });
  };

  const clearAll = () => {
    setQueryValue("");
    setLocationFilter([]);
    setStatusFilter([]);
    setSearchParams(new URLSearchParams());
  };

  const formatDays = (d: number | null) => {
    if (d == null) return "—";
    if (d >= 100) return "99+";
    return d.toFixed(1);
  };

  const tableRows = rows.map((r) => [
    r.productTitle,
    r.variantTitle,
    r.sku || "—",
    r.locationName,
    r.onHand,
    r.onOrder,
    formatDays(r.daysOfCover),
    r.supplierName || "—",
    <Badge key={`${r.variantId}-${r.locationId}`} tone={STATUS_TONE[r.status]}>
      {STATUS_LABEL[r.status]}
    </Badge>,
  ]);

  const outCount = rows.filter((r) => r.status === "OUT").length;
  const lowCount = rows.filter((r) => r.status === "LOW").length;

  return (
    <PageShell
      title="Inventory"
      secondaryActions={[
        { content: "Transfers", url: "/app/inventory/transfers" },
        { content: "Stock takes", url: "/app/inventory/stock-takes" },
        { content: "Adjustments", url: "/app/inventory/adjustments" },
      ]}
    >
      <BlockStack gap="400">
        {(outCount > 0 || lowCount > 0) && (
          <InlineStack gap="200">
            {outCount > 0 && (
              <Text as="p" variant="bodyMd">
                <Badge tone="critical">{outCount} out of stock</Badge>
              </Text>
            )}
            {lowCount > 0 && (
              <Text as="p" variant="bodyMd">
                <Badge tone="warning">{lowCount} low stock</Badge>
              </Text>
            )}
          </InlineStack>
        )}

        <Card>
          <BlockStack gap="400">
            <Filters
              queryValue={queryValue}
              queryPlaceholder="Search product, variant, or SKU"
              onQueryChange={handleQueryChange}
              onQueryClear={handleQueryClear}
              onClearAll={clearAll}
              filters={[
                {
                  key: "location",
                  label: "Location",
                  filter: (
                    <ChoiceList
                      title="Location"
                      titleHidden
                      choices={locations.map((l) => ({ label: l.name, value: l.id }))}
                      selected={locationFilter}
                      onChange={handleLocationChange}
                      allowMultiple={false}
                    />
                  ),
                  shortcut: true,
                },
                {
                  key: "status",
                  label: "Status",
                  filter: (
                    <ChoiceList
                      title="Status"
                      titleHidden
                      choices={[
                        { label: "In stock", value: "IN_STOCK" },
                        { label: "Low", value: "LOW" },
                        { label: "Out of stock", value: "OUT" },
                        { label: "Overstock", value: "OVERSTOCK" },
                      ]}
                      selected={statusFilter}
                      onChange={handleStatusChange}
                      allowMultiple={false}
                    />
                  ),
                  shortcut: true,
                },
              ]}
              appliedFilters={[
                ...(locationFilter[0]
                  ? [
                      {
                        key: "location",
                        label: locations.find((l) => l.id === locationFilter[0])?.name ?? "Location",
                        onRemove: () => handleLocationChange([]),
                      },
                    ]
                  : []),
                ...(statusFilter[0]
                  ? [
                      {
                        key: "status",
                        label: STATUS_LABEL[statusFilter[0] as InventoryStatus] ?? statusFilter[0],
                        onRemove: () => handleStatusChange([]),
                      },
                    ]
                  : []),
              ]}
            >
              <Box paddingInlineStart="200">
                <Button onClick={() => applyFilters({ search: queryValue })}>Search</Button>
              </Box>
            </Filters>

            {rows.length === 0 ? (
              <EmptyState
                heading="No inventory to show"
                action={{ content: "Resync in Settings", onAction: () => navigate("/app/settings") }}
                secondaryAction={{
                  content: "Clear filters",
                  onAction: clearAll,
                }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  Sync products and locations from Settings, or clear filters if you&apos;re not seeing
                  expected items.
                </p>
              </EmptyState>
            ) : (
              <>
                <Text as="p" variant="bodySm" tone="subdued">
                  Showing {rows.length} row{rows.length === 1 ? "" : "s"}
                  {rows.length >= 500 ? " (capped at 500)" : ""}. Days of cover uses last 60 days of
                  sales.
                </Text>
                <DataTable
                  columnContentTypes={[
                    "text",
                    "text",
                    "text",
                    "text",
                    "numeric",
                    "numeric",
                    "numeric",
                    "text",
                    "text",
                  ]}
                  headings={[
                    "Product",
                    "Variant",
                    "SKU",
                    "Location",
                    "On hand",
                    "On order",
                    "Days of cover",
                    "Supplier",
                    "Status",
                  ]}
                  rows={tableRows}
                  hoverable
                />
              </>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </PageShell>
  );
}
