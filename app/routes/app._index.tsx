import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useRevalidator, useSearchParams } from "@remix-run/react";
import { useState } from "react";
import {
  Layout,
  Text,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Button,
  ButtonGroup,
  DataTable,
  Box,
  EmptyState,
  Banner,
  Tooltip,
  Badge,
} from "@shopify/polaris";
import { PageShell } from "../components/PageShell";
import "../styles/dashboard-lowstock-table.css";
import "../styles/bulk-assign-modal.css";
import { BulkAssignModal } from "../components/BulkAssignModal";
import { authenticate } from "../shopify.server";
import { getDashboardData, getDashboardCountsByMode, type VelocityMode, type ModeCounts } from "../services/dashboard.server";
import { getIncompleteVariantCount, getUnassignedVariantCount } from "../services/supplier-assignment.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) {
    return {
      data: null,
      hasData: false,
      hasPrimaryWarehouse: false,
      primaryWarehouseInvalid: false,
      incompleteVariantCount: 0,
      unassignedVariantCount: 0,
      velocityMode: "last60" as VelocityMode,
      countsByMode: null as Record<VelocityMode, ModeCounts> | null,
    };
  }

  const url = new URL(request.url);
  const rawMode = url.searchParams.get("velocityMode") || "last60";
  const velocityMode = ["last30", "last60", "yoy", "fillToTarget"].includes(rawMode) ? (rawMode as VelocityMode) : ("last60" as VelocityMode);

  const [data, hasData, primaryWarehouseStatus, incompleteVariantCount, unassignedVariantCount, countsByMode] = await Promise.all([
    getDashboardData(shop.id, { velocityMode }),
    (async () => {
      const [vCount, lCount] = await Promise.all([
        prisma.variant.count({ where: { shopId: shop.id } }),
        prisma.location.count({ where: { shopId: shop.id } }),
      ]);
      return vCount > 0 && lCount > 0;
    })(),
    prisma.shop.findUnique({ where: { id: shop.id }, include: { primaryWarehouseLocation: true } }).then((s) => {
      const valid = !!(s?.primaryWarehouseLocationId && s?.primaryWarehouseLocation?.isActive);
      const invalid = !!(s?.primaryWarehouseLocationId && (!s?.primaryWarehouseLocation || !s?.primaryWarehouseLocation?.isActive));
      return { valid, invalid, primaryWarehouse: s?.primaryWarehouseLocation ?? null };
    }),
    getIncompleteVariantCount(shop.id),
    getUnassignedVariantCount(shop.id),
    getDashboardCountsByMode(shop.id),
  ]);
  const hasPrimaryWarehouse = primaryWarehouseStatus?.valid ?? false;
  const primaryWarehouseInvalid = primaryWarehouseStatus?.invalid ?? false;
  const primaryWarehouse = primaryWarehouseStatus?.primaryWarehouse ?? null;

  return { data, hasData, hasPrimaryWarehouse, primaryWarehouseInvalid, primaryWarehouse, incompleteVariantCount, unassignedVariantCount, velocityMode, countsByMode };
};

function formatDaysOfCover(days: number | null): string {
  if (days == null || days >= 999) return "—";
  return days.toFixed(1);
}

export default function Dashboard() {
  const { data, hasData, hasPrimaryWarehouse, primaryWarehouseInvalid, primaryWarehouse, incompleteVariantCount, unassignedVariantCount, velocityMode, countsByMode } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const [assignModalOpen, setAssignModalOpen] = useState(false);

  if (!hasData) {
    return (
      <PageShell title="Dashboard" primaryAction={{ content: "View reorder suggestions", url: "/app/reorder" }}>
        <BlockStack gap="500">
          <Card>
            <EmptyState
              heading="Sync your inventory first"
              action={{
                content: "Go to Settings",
                url: "/app/settings",
              }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>Sync products, variants, locations, and inventory from Settings to see reorder suggestions and metrics.</p>
            </EmptyState>
          </Card>
        </BlockStack>
      </PageShell>
    );
  }

  if (!data) {
    return (
      <PageShell title="Dashboard">
        <Text as="p">Loading...</Text>
      </PageShell>
    );
  }

  const {
    itemsToReorderCount,
    openPOCount,
    draftPOCount,
    awaitingPOCount,
    incomingUnits,
    stockoutsUnder7DaysCount,
    topReorderRisks,
    bestSellers,
    lostRevenue,
    suggestedOrderCost,
  } = data;

  const velocityModes: { id: VelocityMode; label: string }[] = [
    { id: "last30", label: "Last 30 days" },
    { id: "last60", label: "Last 60 days" },
    { id: "yoy", label: "Same period last year" },
    { id: "fillToTarget", label: "Fill to target" },
  ];

  const getBadgeTone = (c: ModeCounts): "critical" | "attention" | "success" => {
    if (c.criticalCount > 0) return "critical";
    if (c.itemsToReorder > 0) return "attention";
    return "success";
  };

  const handleVelocityModeChange = (index: number) => {
    const mode = velocityModes[index]?.id ?? "last60";
    setSearchParams((p) => {
      const n = new URLSearchParams(p);
      n.set("velocityMode", mode);
      return n;
    });
  };

  // Static row: never changes with velocity mode
  const staticCards = [
    { label: "Draft POs", value: draftPOCount, tooltip: "Purchase orders not yet sent to suppliers" },
    { label: "POs awaiting delivery", value: awaitingPOCount, tooltip: "Purchase orders sent and awaiting delivery" },
    { label: "Incoming units", value: incomingUnits, tooltip: "Total units on order from open POs (excluding drafts)" },
  ];

  // Dynamic row: changes with velocity mode
  const dynamicCards = [
    {
      label: "Lost revenue",
      value: lostRevenue != null ? `$${lostRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "$0.00",
      tooltip: "Potential sales lost from low stock (7-day projection at current velocity)",
      tone: lostRevenue != null && lostRevenue > 0 ? ("critical" as const) : undefined,
    },
    {
      label: "Low stock",
      value: itemsToReorderCount,
      tooltip: "Items with a suggested order quantity based on sales velocity and lead time",
    },
    {
      label: "Stockouts < 7 days",
      value: stockoutsUnder7DaysCount,
      tooltip: "Items that will run out of stock within 7 days at current sales velocity",
      tone: stockoutsUnder7DaysCount > 0 ? ("critical" as const) : undefined,
    },
    {
      label: "Cost to order",
      value: `$${suggestedOrderCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      tooltip: "Total cost to place current recommended reorders (unit cost × suggested quantity)",
    },
  ];

  const tableRows = topReorderRisks.map((r) => [
    r.productTitle,
    r.variantTitle,
    r.locationName,
    String(r.onHand),
    String(r.onOrder),
    r.avgDailySales.toFixed(2),
    formatDaysOfCover(r.daysOfCover),
    String(r.suggestedQty),
    <Button
      key={r.variantId}
      variant="plain"
      url="/app/reorder"
      size="slim"
    >
      Add to PO
    </Button>,
  ]);

  return (
    <PageShell title="Dashboard" primaryAction={{ content: "View reorder suggestions", url: "/app/reorder" }}>
      <BlockStack gap="500">
        {hasData && unassignedVariantCount > 0 && (
          <Banner
            title={`${unassignedVariantCount} item${unassignedVariantCount !== 1 ? "s" : ""} don't have a supplier assigned`}
            action={{ content: "Assign item", onAction: () => setAssignModalOpen(true) }}
            tone="warning"
          >
            Assign suppliers to these items to enable purchase orders and reorder suggestions.
          </Banner>
        )}
        {hasData && incompleteVariantCount > 0 && (
          <Banner
            title={`${incompleteVariantCount} variant${incompleteVariantCount !== 1 ? "s" : ""} need cost and lead time`}
            action={{ content: "Fix in suppliers", url: "/app/suppliers" }}
            tone="warning"
          >
            Some supplier assignments are missing unit cost or lead time. Add this info so reorder suggestions work correctly.
          </Banner>
        )}
        {hasData && primaryWarehouseInvalid && (
          <Banner
            title={primaryWarehouse ? `${primaryWarehouse.name} is no longer available` : "Receiving location no longer available"}
            action={{ content: "Select a location", url: "/app/settings" }}
            tone="critical"
          >
            {primaryWarehouse ? `${primaryWarehouse.name} was deleted or deactivated in Shopify.` : "Your receiving location was deleted or deactivated in Shopify."} Select a new one in settings to continue.
          </Banner>
        )}
        {hasData && !hasPrimaryWarehouse && !primaryWarehouseInvalid && (
          <Banner
            title="No receiving location selected"
            action={{ content: "Select a location", url: "/app/onboarding" }}
            tone="critical"
          >
            Select where you receive inventory in Settings to see reorder suggestions.
          </Banner>
        )}

        {/* Static row: Draft POs, POs awaiting delivery, Incoming units */}
        <InlineGrid columns={{ xs: 2, sm: 3, md: 3 }} gap="400">
          {staticCards.map((card) => (
            <Card key={card.label}>
              <BlockStack gap="100">
                <InlineStack gap="100" blockAlign="center">
                  <Text as="p" variant="bodyMd" tone="subdued">
                    {card.label}
                  </Text>
                  <Tooltip content={card.tooltip}>
                    <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                  </Tooltip>
                </InlineStack>
                <Text as="p" variant="headingXl">{card.value}</Text>
              </BlockStack>
            </Card>
          ))}
        </InlineGrid>

        {/* Velocity mode selector - segmented control with counts and urgency colors */}
        <Card>
          <BlockStack gap="400">
            <InlineStack gap="100" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Velocity mode
              </Text>
              <Tooltip content="How we calculate sales velocity for reorder suggestions. Last 30/60 days uses recent sales. Same period last year uses last year's data (seasonal). Fill to target orders up to max stock.">
                <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
              </Tooltip>
            </InlineStack>
            <ButtonGroup variant="segmented" fullWidth>
              {velocityModes.map((m, index) => {
                const c = countsByMode?.[m.id] ?? { itemsToReorder: 0, criticalCount: 0, fixableCount: 0 };
                const tone = getBadgeTone(c);
                return (
                  <Button
                    key={m.id}
                    pressed={velocityMode === m.id}
                    onClick={() => handleVelocityModeChange(index)}
                    size="slim"
                  >
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span" variant="bodyMd" fontWeight={velocityMode === m.id ? "semibold" : "regular"}>
                        {m.label}
                      </Text>
                      <Badge tone={tone}>{c.itemsToReorder}</Badge>
                    </InlineStack>
                  </Button>
                );
              })}
            </ButtonGroup>
          </BlockStack>
        </Card>

        {/* Dynamic row: Lost revenue, Low stock, Stockouts, Cost to order - changes with velocity mode */}
        <InlineGrid columns={{ xs: 2, sm: 2, md: 4 }} gap="400">
          {dynamicCards.map((card) => (
            <Card key={card.label}>
              <BlockStack gap="100">
                <InlineStack gap="100" blockAlign="center">
                  <Text as="p" variant="bodyMd" tone="subdued">
                    {card.label}
                  </Text>
                  <Tooltip content={card.tooltip}>
                    <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                  </Tooltip>
                </InlineStack>
                <Text as="p" variant="headingXl" tone={card.tone}>
                  {card.value}
                </Text>
              </BlockStack>
            </Card>
          ))}
        </InlineGrid>

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center" gap="400">
              <Text as="h2" variant="headingMd">
                Low stock
              </Text>
              <Button variant="primary" url="/app/reorder">
                View reorder suggestions
              </Button>
            </InlineStack>

            {topReorderRisks.length === 0 ? (
              <Box padding="400">
                <Text as="p" variant="bodyMd" tone="subdued">
                  No low stock items. Your inventory levels look healthy.
                </Text>
              </Box>
            ) : (
              <div className="dashboard-lowstock-table">
              <DataTable
                columnContentTypes={[
                  "text",
                  "text",
                  "text",
                  "numeric",
                  "numeric",
                  "numeric",
                  "numeric",
                  "numeric",
                  "text",
                ]}
                headings={[
                  "Product",
                  "Variant",
                  "Location",
                  "On Hand",
                  "On Order",
                  "Avg/Day",
                  "Days of Cover",
                  "Suggested",
                  "",
                ]}
                rows={tableRows}
              />
              </div>
            )}
          </BlockStack>
        </Card>

        {bestSellers.length > 0 && (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Best sellers
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Top products by units sold (last 30 days)
              </Text>
              <DataTable
                columnContentTypes={["text", "text", "numeric", "numeric", "numeric", "numeric", "numeric"]}
                headings={["Product", "Variant", "Units sold", "Revenue", "Cost", "Profit", "Margin"]}
                rows={bestSellers.map((b) => [
                  b.productTitle,
                  b.variantTitle,
                  b.unitsSold,
                  `$${b.revenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                  b.cost != null ? `$${b.cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—",
                  b.profit != null ? `$${b.profit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—",
                  b.marginPct != null ? `${b.marginPct.toFixed(1)}%` : "—",
                ])}
              />
            </BlockStack>
          </Card>
        )}

        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Purchase Orders
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  {draftPOCount} draft PO{draftPOCount !== 1 ? "s" : ""}, {awaitingPOCount} awaiting delivery
                </Text>
                <Button variant="primary" url="/app/purchase-orders">
                  View POs
                </Button>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Suppliers
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Manage suppliers and link variants
                </Text>
                <Button variant="primary" url="/app/suppliers">
                  Manage suppliers
                </Button>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                Settings
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Sync data, reorder defaults
                </Text>
                <Button variant="primary" url="/app/settings">
                  Settings
                </Button>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
        <BulkAssignModal
          open={assignModalOpen}
          onClose={() => setAssignModalOpen(false)}
          onSuccess={() => revalidator.revalidate()}
        />
      </BlockStack>
    </PageShell>
  );
}
