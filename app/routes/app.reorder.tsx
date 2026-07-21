import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams, useRevalidator, useFetcher, useNavigate } from "@remix-run/react";
import {
  Card,
  DataTable,
  Filters,
  ChoiceList,
  TextField,
  Button,
  ButtonGroup,
  BlockStack,
  InlineStack,
  Text,
  Banner,
  Tooltip,
  Badge,
} from "@shopify/polaris";
import { PageShell } from "../components/PageShell";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { authenticate } from "../shopify.server";
import { getReorderSuggestions } from "../services/reorder.server";
import { getDashboardCountsByMode, type VelocityMode, type ModeCounts } from "../services/dashboard.server";
import { getUnassignedVariantCount, getIncompleteVariantCount, getIncompleteVariantIds } from "../services/supplier-assignment.server";
import { bulkAssignVariants } from "../services/supplier-assignment.server";
import prisma from "../db.server";
import { BulkAssignModal } from "../components/BulkAssignModal";
import { InlineAssignModal } from "../components/InlineAssignModal";
import { EditVariantSupplierModal } from "../components/EditVariantSupplierModal";
import "../styles/reorder-table.css";
import "../styles/bulk-assign-modal.css";

const VELOCITY_MODES: { id: VelocityMode; label: string }[] = [
  { id: "last30", label: "Last 30 days" },
  { id: "last60", label: "Last 60 days" },
  { id: "yoy", label: "Same period last year" },
  { id: "fillToTarget", label: "Fill to target" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { rows: [], suppliers: [], unassignedCount: 0, incompleteCount: 0, incompleteVariantIds: [], hasPrimaryWarehouse: false, primaryWarehouseInvalid: false, primaryWarehouse: null, hasSkus: false, velocityMode: "last60" as VelocityMode, countsByMode: null as Record<VelocityMode, ModeCounts> | null };

  const url = new URL(request.url);
  const supplierIds = url.searchParams.getAll("supplier").filter(Boolean);
  const lowStock = url.searchParams.get("lowStock") === "1";
  const search = url.searchParams.get("search") || undefined;
  const rawMode = url.searchParams.get("velocityMode") || "last60";
  const velocityMode = ["last30", "last60", "yoy", "fillToTarget"].includes(rawMode) ? (rawMode as VelocityMode) : ("last60" as VelocityMode);
  const windowDays = velocityMode === "last30" ? 30 : 60;

  const shopWithPrimary = await prisma.shop.findUnique({
    where: { id: shop.id },
    include: { primaryWarehouseLocation: true },
  });
  const hasPrimaryWarehouse =
    !!shopWithPrimary?.primaryWarehouseLocationId &&
    !!shopWithPrimary?.primaryWarehouseLocation?.isActive;
  const primaryWarehouseInvalid =
    !!shopWithPrimary?.primaryWarehouseLocationId &&
    (!shopWithPrimary?.primaryWarehouseLocation || !shopWithPrimary?.primaryWarehouseLocation?.isActive);

  const [rows, suppliers, unassignedCount, incompleteCount, incompleteVariantIds, variantsSample, countsByMode] = await Promise.all([
    getReorderSuggestions(shop.id, {
      supplierIds: supplierIds.length > 0 ? supplierIds : undefined,
      lowStockOnly: lowStock,
      search,
      windowDays,
      velocityMode,
    }),
    prisma.supplier.findMany({
      where: { shopId: shop.id },
      select: { id: true, name: true },
    }),
    getUnassignedVariantCount(shop.id),
    getIncompleteVariantCount(shop.id),
    getIncompleteVariantIds(shop.id),
    prisma.variant.findMany({
      where: { shopId: shop.id },
      select: { sku: true },
      take: 500,
    }),
    getDashboardCountsByMode(shop.id),
  ]);

  const skuCount = variantsSample.filter((v) => v.sku != null && String(v.sku).trim() !== "").length;
  const hasSkus = skuCount > variantsSample.length * 0.1; // thin column if <10% of variants use SKU

  return {
    rows,
    suppliers,
    unassignedCount,
    incompleteCount,
    incompleteVariantIds,
    hasPrimaryWarehouse,
    primaryWarehouseInvalid,
    primaryWarehouse: shopWithPrimary?.primaryWarehouseLocation ?? null,
    hasSkus,
    velocityMode,
    countsByMode,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return json({ success: false, error: "Shop not found" }, { status: 404 });

  const formData = await request.formData();
  const intent = formData.get("intent");
  if (intent !== "bulkAssign" && intent !== "inlineAssign" && intent !== "addToPO" && intent !== "bulkAddToPO" && intent !== "updateVariantSupplier")
    return json({ success: false, error: "Invalid intent" }, { status: 400 });

  if (intent === "bulkAddToPO") {
    const payloadJson = formData.get("payload");
    const payload = payloadJson ? (JSON.parse(String(payloadJson)) as Array<{ variantId: string; quantity: number }>) : [];
    if (!payload.length) return json({ success: false, error: "No variants selected" }, { status: 400 });
    const { addReorderLineToPO } = await import("../services/purchase-order.server");
    let lastPoId: string | undefined;
    for (const { variantId, quantity } of payload) {
      if (!variantId || quantity < 1) continue;
      const result = await addReorderLineToPO(shop.id, variantId, quantity);
      if (result.success && result.poId) lastPoId = result.poId;
    }
    return lastPoId ? json({ success: true, poId: lastPoId }) : json({ success: false, error: "Could not add to PO" }, { status: 400 });
  }

  if (intent === "addToPO") {
    const variantId = String(formData.get("variantId") || "");
    const quantity = parseInt(String(formData.get("quantity") || "0"), 10);
    if (!variantId || quantity < 1) {
      return json({ success: false, error: "Variant and quantity required" }, { status: 400 });
    }
    const { addReorderLineToPO } = await import("../services/purchase-order.server");
    const result = await addReorderLineToPO(shop.id, variantId, quantity);
    if (!result.success) {
      return json({ success: false, error: result.error }, { status: 400 });
    }
    return json({ success: true, poId: result.poId });
  }

  if (intent === "updateVariantSupplier") {
    const variantSupplierId = String(formData.get("variantSupplierId") || "");
    const cost = String(formData.get("cost") || "").trim() || null;
    const leadTimeDays = parseInt(String(formData.get("leadTimeDays") ?? "0"), 10);
    const minStockRaw = String(formData.get("minStock") || "").trim();
    const maxStockRaw = String(formData.get("maxStock") || "").trim();
    const minOrderQtyRaw = String(formData.get("minOrderQty") || "").trim();
    const minStock = minStockRaw ? parseInt(minStockRaw, 10) : null;
    const maxStock = maxStockRaw ? parseInt(maxStockRaw, 10) : null;
    const minOrderQty = minOrderQtyRaw ? parseInt(minOrderQtyRaw, 10) : null;

    const vs = await prisma.variantSupplier.findFirst({
      where: { id: variantSupplierId },
      include: { variant: true },
    });
    if (!vs || vs.variant.shopId !== shop.id) {
      return json({ success: false, error: "Variant supplier not found" }, { status: 404 });
    }
    await prisma.variantSupplier.update({
      where: { id: vs.id },
      data: {
        cost,
        leadTimeDays: leadTimeDays >= 0 ? leadTimeDays : vs.leadTimeDays,
        minStock: minStock != null && !Number.isNaN(minStock) && minStock >= 0 ? minStock : null,
        maxStock: maxStock != null && !Number.isNaN(maxStock) && maxStock >= 0 ? maxStock : null,
        minOrderQty: minOrderQty != null && !Number.isNaN(minOrderQty) && minOrderQty >= 0 ? minOrderQty : null,
      },
    });
    return json({ success: true });
  }

  if (intent === "inlineAssign") {
    const variantId = String(formData.get("variantId") || "");
    const supplierId = String(formData.get("supplierId") || "");
    const unitCost = String(formData.get("unitCost") || "").trim();
    const leadTimeDays = parseInt(String(formData.get("leadTimeDays") || "0"), 10);
    if (!variantId || !supplierId || !unitCost || leadTimeDays < 0) {
      return json({ success: false, error: "Variant, supplier, cost, and lead time required" }, { status: 400 });
    }
    const { assignSingleVariant } = await import("../services/supplier-assignment.server");
    const result = await assignSingleVariant(shop.id, variantId, supplierId, { unitCost, leadTimeDays });
    return result.success ? json({ success: true }) : json({ success: false, error: result.error }, { status: 400 });
  }

  const variantIds = JSON.parse(String(formData.get("variantIds") || "[]")) as string[];
  const supplierId = String(formData.get("supplierId") || "");
  const unitCost = String(formData.get("unitCost") || "").trim() || null;
  const leadTimeDaysRaw = formData.get("leadTimeDays");
  const leadTimeDays = leadTimeDaysRaw != null && leadTimeDaysRaw !== "" ? parseInt(String(leadTimeDaysRaw), 10) : null;
  const supplierSku = String(formData.get("supplierSku") || "").trim() || null;

  if (!variantIds.length || !supplierId) {
    return json({ success: false, error: "Variant IDs and supplier required" }, { status: 400 });
  }

  const result = await bulkAssignVariants(shop.id, variantIds, supplierId, {
    unitCost: unitCost || undefined,
    leadTimeDays: leadTimeDays != null && leadTimeDays >= 0 ? leadTimeDays : undefined,
    supplierSku: supplierSku || undefined,
  });
  if (result.error) return json({ success: false, error: result.error }, { status: 400 });

  return json({ success: true, assigned: result.assigned });
};

export default function Reorder() {
  const {
    rows,
    suppliers,
    unassignedCount,
    incompleteCount,
    incompleteVariantIds,
    hasPrimaryWarehouse,
    primaryWarehouseInvalid,
    primaryWarehouse,
    hasSkus,
    velocityMode,
    countsByMode,
  } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();

  const getBadgeTone = (c: ModeCounts): "critical" | "attention" | "success" => {
    if (c.criticalCount > 0) return "critical";
    if (c.itemsToReorder > 0) return "attention";
    return "success";
  };

  const handleVelocityModeChange = useCallback(
    (index: number) => {
      const mode = VELOCITY_MODES[index]?.id ?? "last60";
      setSearchParams((p) => {
        const n = new URLSearchParams(p);
        n.set("velocityMode", mode);
        return n;
      });
    },
    [setSearchParams]
  );
  const addToPOFetcher = useFetcher<{ success?: boolean; poId?: string; error?: string }>();
  const navigate = useNavigate();

  const handleAddToPO = useCallback(
    (variantId: string, quantity: number) => {
      if (addToPOFetcher.state !== "idle") return;
      const formData = new FormData();
      formData.set("intent", "addToPO");
      formData.set("variantId", variantId);
      formData.set("quantity", String(quantity));
      addToPOFetcher.submit(formData, { method: "post", action: "/app/reorder" });
    },
    [addToPOFetcher]
  );

  const hasNavigatedRef = useRef(false);
  useEffect(() => {
    const data = addToPOFetcher.data;
    if (data?.success && data?.poId && addToPOFetcher.state === "idle" && !hasNavigatedRef.current) {
      hasNavigatedRef.current = true;
      navigate(`/app/purchase-orders/${data.poId}`);
    }
  }, [addToPOFetcher.data, addToPOFetcher.state, navigate]);

  const [searchValue, setSearchValue] = useState(searchParams.get("search") || "");
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [inlineAssignVariant, setInlineAssignVariant] = useState<{ id: string; label: string } | null>(null);
  const [editDetailsVariant, setEditDetailsVariant] = useState<{
    variantSupplierId: string;
    supplierId: string;
    productTitle: string;
    variantTitle: string;
    cost: string;
    leadTimeDays: number;
    minStock: number | null;
    maxStock: number | null;
    minOrderQty: number | null;
  } | null>(null);

  const handleFiltersClearAll = useCallback(() => {
    setSearchParams({});
    setSearchValue("");
  }, [setSearchParams]);

  const handleQueryClear = useCallback(() => {
    setSearchValue("");
    setSearchParams((p) => {
      const n = new URLSearchParams(p);
      n.delete("search");
      return n;
    });
  }, [setSearchParams]);

  const handleSupplierChange = useCallback(
    (value: string[]) => {
      const params = new URLSearchParams(searchParams);
      params.delete("supplier");
      value.forEach((id) => params.append("supplier", id));
      setSearchParams(params);
    },
    [searchParams, setSearchParams]
  );

  const handleLowStockChange = useCallback(
    (value: string[]) => {
      const params = new URLSearchParams(searchParams);
      if (value.includes("lowStock")) params.set("lowStock", "1");
      else params.delete("lowStock");
      setSearchParams(params);
    },
    [searchParams, setSearchParams]
  );

  const handleSupplierRemove = useCallback(() => {
    setSearchParams((p) => {
      const n = new URLSearchParams();
      p.forEach((v, k) => {
        if (k !== "supplier") n.set(k, v);
      });
      return n;
    });
  }, [setSearchParams]);

  const handleLowStockRemove = useCallback(() => {
    setSearchParams((p) => {
      const n = new URLSearchParams(p);
      n.delete("lowStock");
      return n;
    });
  }, [setSearchParams]);

  const appliedFilters = useMemo(() => {
    const applied: { key: string; label: string; onRemove: () => void }[] = [];
    const supplierIds = searchParams.getAll("supplier").filter(Boolean);
    if (supplierIds.length > 0) {
      const names = supplierIds
        .map((id) => suppliers.find((s) => s.id === id)?.name ?? id)
        .join(", ");
      applied.push({ key: "supplier", label: names, onRemove: handleSupplierRemove });
    }
    if (searchParams.get("lowStock") === "1") {
      applied.push({ key: "lowStock", label: "Needs reorder only", onRemove: handleLowStockRemove });
    }
    return applied;
  }, [searchParams, suppliers, handleSupplierRemove, handleLowStockRemove]);

  // Debounced search - apply to URL when user stops typing
  useEffect(() => {
    const t = setTimeout(() => {
      const current = searchParams.get("search") || "";
      if (searchValue === current) return;
      setSearchParams((p) => {
        const n = new URLSearchParams(p);
        if (searchValue) n.set("search", searchValue);
        else n.delete("search");
        return n;
      });
    }, 300);
    return () => clearTimeout(t);
  }, [searchValue, searchParams, setSearchParams]);

  const filters = [
    {
      key: "supplier",
      label: "Supplier",
      pinned: true,
      filter: (
        <ChoiceList
          title="Supplier"
          choices={suppliers.map((s) => ({ label: s.name, value: s.id }))}
          selected={searchParams.getAll("supplier").filter(Boolean)}
          onChange={handleSupplierChange}
          allowMultiple
        />
      ),
    },
    {
      key: "lowStock",
      label: "Stock level",
      pinned: true,
      filter: (
        <ChoiceList
          title="Stock level"
          choices={[{ label: "Show only items that need reordering", value: "lowStock" }]}
          selected={searchParams.get("lowStock") === "1" ? ["lowStock"] : []}
          onChange={handleLowStockChange}
        />
      ),
    },
  ];

  const tableRows = rows.map((r) => [
    <span key={`${r.variantId}-p`} className="reorder-wrap-text">{r.productTitle}</span>,
    <span key={`${r.variantId}-v`} className="reorder-wrap-text">{r.variantTitle}</span>,
    <span key={`${r.variantId}-sku`} className="reorder-wrap-text">{r.sku || "—"}</span>,
    r.supplierName ? (
      r.detailsComplete ? (
        r.supplierName
      ) : r.variantSupplierId && r.supplierId ? (
        <InlineStack key={r.variantId} gap="100" blockAlign="center">
          <span>{r.supplierName}</span>
          <Button
            variant="plain"
            size="slim"
            onClick={() =>
              setEditDetailsVariant({
                variantSupplierId: r.variantSupplierId!,
                supplierId: r.supplierId!,
                productTitle: r.productTitle,
                variantTitle: r.variantTitle,
                cost: r.unitCost ?? "",
                leadTimeDays: r.leadTimeDays,
                minStock: r.minStock ?? null,
                maxStock: r.maxStock ?? null,
                minOrderQty: r.minOrderQty ?? null,
              })
            }
          >
            Details required
          </Button>
        </InlineStack>
      ) : (
        <span title="Add cost and lead time on the supplier page">{r.supplierName} (details needed)</span>
      )
    ) : (
      <button
        key={r.variantId}
        type="button"
        onClick={() => setInlineAssignVariant({ id: r.variantId, label: `${r.productTitle} - ${r.variantTitle}` })}
        style={{
          background: "var(--p-color-bg-fill-critical)",
          color: "var(--p-color-text-on-fill-critical)",
          border: "none",
          borderRadius: "var(--p-border-radius-100)",
          padding: "2px 8px",
          fontSize: "12px",
          cursor: "pointer",
        }}
      >
        Unassigned
      </button>
    ),
    <span key={`${r.variantId}-l`} className="reorder-wrap-text">{r.locationName}</span>,
    r.onHand,
    r.onOrder,
    r.unitCost ?? "—",
    r.marginPct != null ? `${r.marginPct.toFixed(1)}%` : "—",
    r.avgDailySales.toFixed(2),
    r.daysOfCover != null ? r.daysOfCover.toFixed(1) : "—",
    r.detailsComplete ? r.suggestedQty : "—",
    r.detailsComplete && r.suggestedQty > 0 ? (
      <Button
        key={r.variantId}
        variant="plain"
        size="slim"
        onClick={() => handleAddToPO(r.variantId, r.suggestedQty)}
        disabled={addToPOFetcher.state !== "idle"}
        loading={addToPOFetcher.state !== "idle"}
      >
        Add to PO
      </Button>
    ) : r.supplierName && !r.detailsComplete ? (
      <span title="Add cost and lead time to enable">—</span>
    ) : !r.supplierName ? (
      <span title="Assign supplier first">—</span>
    ) : (
      "—"
    ),
  ]);

  const selectableRows = rows.filter((r) => r.detailsComplete && r.suggestedQty > 0);
  const hasSelectable = selectableRows.length > 0;

  return (
    <PageShell
      title="Reorder suggestions"
      primaryAction={{
        content: "Create purchase order",
        url: "/app/purchase-orders/new",
        disabled: !hasSelectable,
      }}
      secondaryActions={[{ content: "Resync data", url: "/app/settings" }]}
    >
      <BlockStack gap="400">
        {primaryWarehouseInvalid && (
          <Banner
            title={primaryWarehouse ? `${primaryWarehouse.name} is no longer available` : "Receiving location no longer available"}
            action={{ content: "Select a location", url: "/app/settings" }}
            tone="critical"
          >
            {primaryWarehouse ? `${primaryWarehouse.name} was deleted or deactivated in Shopify.` : "Your receiving location was deleted or deactivated in Shopify."} Select a new one in settings to continue.
          </Banner>
        )}
        {!hasPrimaryWarehouse && !primaryWarehouseInvalid && (
          <Banner
            title="No receiving location selected"
            action={{ content: "Select a location", url: "/app/onboarding" }}
            tone="critical"
          >
            Select where you receive inventory in Settings to see reorder suggestions.
          </Banner>
        )}
        {hasPrimaryWarehouse && unassignedCount > 0 && (
          <Banner
            title={`${unassignedCount} item${unassignedCount !== 1 ? "s" : ""} don't have a supplier assigned`}
            action={{ content: "Assign item", onAction: () => setAssignModalOpen(true) }}
            tone="warning"
          >
            Assign suppliers to these items to enable purchase orders and reorder suggestions.
          </Banner>
        )}
        {hasPrimaryWarehouse && incompleteCount > 0 && (
          <Banner
            title={`${incompleteCount} SKU${incompleteCount !== 1 ? "s" : ""} need cost and lead time.`}
            action={{ content: "Go to suppliers", url: "/app/suppliers" }}
            tone="warning"
          >
            <p>Add cost and lead time to enable reorder suggestions and purchase orders. Click "Details required" on a row to edit, or go to suppliers.</p>
          </Banner>
        )}
        {hasPrimaryWarehouse && (
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
                {VELOCITY_MODES.map((m, index) => {
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
        )}
        <Filters
          queryPlaceholder="SKU, product..."
          queryValue={searchValue}
          onQueryChange={setSearchValue}
          onQueryClear={handleQueryClear}
          filters={filters}
          appliedFilters={appliedFilters}
          onClearAll={handleFiltersClearAll}
        />
        <Card>
          <div className={`reorder-table-wrapper${!hasSkus ? " reorder-sku-thin" : ""}`}>
          <DataTable
            verticalAlign="middle"
            columnContentTypes={["text", "text", "text", "text", "text", "numeric", "numeric", "text", "text", "numeric", "numeric", "numeric", "text"]}
            headings={[
              <Tooltip key="product" content="Product name from your Shopify catalog">
                <strong>Product</strong>
              </Tooltip>,
              <Tooltip key="variant" content="Variant option (e.g. size, color) from the product">
                <strong>Variant</strong>
              </Tooltip>,
              <Tooltip key="sku" content="Stock keeping unit – unique identifier for this variant">
                <strong>SKU</strong>
              </Tooltip>,
              <Tooltip key="supplier" content="Supplier assigned to this variant for ordering">
                <strong>Supplier</strong>
              </Tooltip>,
              <Tooltip key="location" content="Warehouse location where stock is tracked">
                <strong>Location</strong>
              </Tooltip>,
              <Tooltip key="onHand" content="Current available quantity at this location">
                <strong>On Hand</strong>
              </Tooltip>,
              <Tooltip key="onOrder" content="Quantity already on order (open POs)">
                <strong>On Order</strong>
              </Tooltip>,
              <Tooltip key="cost" content="Unit cost from supplier">
                <strong>Cost</strong>
              </Tooltip>,
              <Tooltip key="margin" content="Margin % = (retail price − cost) ÷ retail price">
                <strong>Margin</strong>
              </Tooltip>,
              <Tooltip key="avgDaily" content="Average units sold per day (last 60 days)">
                <strong>Avg Daily</strong>
              </Tooltip>,
              <Tooltip key="daysCover" content="Days until stockout: (on hand + on order) ÷ avg daily sales">
                <strong>Days</strong>
              </Tooltip>,
              <Tooltip key="suggested" content="Recommended quantity to order based on demand and lead time">
                <strong>Suggested Order</strong>
              </Tooltip>,
              <Tooltip key="action" content="Add this quantity to a purchase order">
                <strong>Action</strong>
              </Tooltip>,
            ]}
            rows={tableRows}
          />
          </div>
        </Card>
        {hasSelectable && (
          <InlineStack gap="300">
            <Button variant="primary" url="/app/purchase-orders/new">
              Create PO
            </Button>
          </InlineStack>
        )}
        <BulkAssignModal
          open={assignModalOpen}
          onClose={() => setAssignModalOpen(false)}
          onSuccess={() => revalidator.revalidate()}
        />
        {editDetailsVariant && (
          <EditVariantSupplierModal
            open={!!editDetailsVariant}
            onClose={() => setEditDetailsVariant(null)}
            variantSupplierId={editDetailsVariant.variantSupplierId}
            supplierId={editDetailsVariant.supplierId}
            productTitle={editDetailsVariant.productTitle}
            variantTitle={editDetailsVariant.variantTitle}
            initialCost={editDetailsVariant.cost}
            initialLeadTimeDays={editDetailsVariant.leadTimeDays}
            initialMinStock={editDetailsVariant.minStock}
            initialMaxStock={editDetailsVariant.maxStock}
            initialMinOrderQty={editDetailsVariant.minOrderQty}
            action="/app/reorder"
            onSuccess={() => revalidator.revalidate()}
          />
        )}
        {inlineAssignVariant && (
          <InlineAssignModal
            open={!!inlineAssignVariant}
            onClose={() => setInlineAssignVariant(null)}
            variantId={inlineAssignVariant.id}
            variantLabel={inlineAssignVariant.label}
            suppliers={suppliers}
            onSuccess={() => revalidator.revalidate()}
          />
        )}
      </BlockStack>
    </PageShell>
  );
}
