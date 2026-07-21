import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useNavigation, useFetcher, useSearchParams, useNavigate } from "@remix-run/react";
import {
  Card,
  DataTable,
  Button,
  BlockStack,
  Text,
  InlineStack,
  Badge,
  Modal,
  Select,
  TextField,
  Layout,
  Box,
  Banner,
  Checkbox,
} from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { PageShell } from "../components/PageShell";
import { AddProductsModal } from "../components/AddProductsModal";
import { useState, useEffect, useRef } from "react";
import { randomUUID } from "node:crypto";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { receiveBatch, reconcileReceivedQty } from "../services/receiving.server";
import { getOnOrderByVariant } from "../services/reorder.server";
import {
  generatePOLinesFromForecast,
  type ForecastMode,
} from "../services/forecast.server";
import { formatPoDisplayNumber } from "../lib/format-po";
import { formatAddress } from "../lib/address";
import "../styles/po-detail.css";

const STATUS_TONE: Record<string, "info" | "success" | "warning" | "critical"> = {
  DRAFT: "info",
  ORDERED: "warning",
  PARTIALLY_RECEIVED: "warning",
  RECEIVED: "success",
  CANCELED: "critical",
};

const FORECAST_MODE_OPTIONS: { label: string; value: ForecastMode }[] = [
  { label: "Last X days (suggestion)", value: "SUGGESTION" },
  { label: "Same period last year", value: "YOY" },
  { label: "Fill shelves (min/max)", value: "FILL_SHELVES" },
  { label: "Fill shelves (if below min)", value: "FILL_SHELVES_IF_BELOW_MIN" },
  { label: "Target stock", value: "TARGET_STOCK" },
  { label: "Custom date range", value: "CUSTOM" },
];

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
      shippingFromLocation: true,
      lines: {
        include: {
          variant: {
            include: {
              product: true,
              inventoryLevels: true,
            },
          },
        },
      },
    },
  });
  if (!po) throw new Response("Not found", { status: 404 });

  const locationId = po.receivingLocationId ?? shop.primaryWarehouseLocationId;
  const onOrderByVariant = await getOnOrderByVariant(shop.id);

  const lineRows = po.lines
    .filter((l) => l.variant?.product != null)
    .map((l) => {
      const il = locationId ? l.variant.inventoryLevels?.find((inv) => inv.locationId === locationId) : null;
      const onHand = il?.available ?? 0;
      const onOrder = onOrderByVariant.get(l.variantId) ?? 0;
      const cost = parseFloat(l.unitCost ?? "0") || 0;
      const total = cost * l.orderedQty;
      return {
        id: l.id,
        productTitle: l.variant.product.title,
        variantTitle: l.variant.title,
        sku: l.variant.sku,
        orderedQty: l.orderedQty,
        receivedQty: l.receivedQty,
        pending: l.orderedQty - l.receivedQty,
        unitCost: l.unitCost,
        total,
        onHand,
        onOrder,
      };
    });

  const locations = await prisma.location.findMany({
    where: { shopId: shop.id, isActive: true },
    select: { id: true, name: true },
  });

  let variantOptionsForAdd: { id: string; productTitle: string; variantTitle: string; sku: string | null; onHand: number; onOrder: number; unitCost: string | null }[] = [];
  if (po.status === "DRAFT" && locationId) {
    const { getSupplierVariantOptionsForPO } = await import("../services/purchase-order.server");
    variantOptionsForAdd = await getSupplierVariantOptionsForPO(shop.id, po.supplierId, locationId);
  }

  const subtotal = lineRows.reduce((sum, r) => sum + r.total, 0);

  return {
    po,
    lineRows,
    locations,
    variantOptionsForAdd,
    subtotal,
    locationId,
    primaryWarehouse: shop.primaryWarehouseLocation,
    shopDomain: shop.domain,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const { admin, session } = auth;
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return json({ success: false, error: "Shop not found" }, { status: 404 });

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: params.id!, shopId: shop.id },
    include: { receivingLocation: true, lines: true },
  });
  if (!po) return json({ success: false, error: "PO not found" }, { status: 404 });

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "restore") {
    if (!po.deletedAt) return json({ success: false, error: "PO is not deleted" }, { status: 400 });
    const { restoreReceivedInventory } = await import("../services/receiving.server");
    if (po.status === "RECEIVED") {
      const result = await restoreReceivedInventory(admin, shop.id, po.id);
      if (!result.success) {
        return json({ success: false, error: result.error ?? "Failed to restore inventory" }, { status: 500 });
      }
    }
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { deletedAt: null },
    });
    return redirect(`/app/purchase-orders/${po.id}`);
  }

  if (po.deletedAt) return json({ success: false, error: "Cannot edit a deleted purchase order" }, { status: 403 });

  if (intent === "receiveSelected") {
    if (!["ORDERED", "PARTIALLY_RECEIVED"].includes(po.status)) {
      return json({ success: false, error: "PO not in receiveable state" }, { status: 400 });
    }
    const lineIds = formData.getAll("lineId") as string[];
    const idempotencyKey = String(formData.get("idempotencyKey") || `receive-${randomUUID()}`);
    const lineUpdates: Array<{ lineId: string; quantity: number }> = [];
    for (const lineId of lineIds) {
      const line = po.lines.find((l) => l.id === lineId);
      if (line) {
        const pending = line.orderedQty - line.receivedQty;
        if (pending > 0) {
          const qtyVal = formData.get(`qty_${lineId}`);
          const quantity = qtyVal != null ? parseInt(String(qtyVal), 10) : pending;
          if (!Number.isNaN(quantity) && quantity > 0) {
            lineUpdates.push({ lineId, quantity: Math.min(quantity, pending) });
          }
        }
      }
    }
    if (lineUpdates.length === 0) {
      return json({ success: false, error: "No valid lines to receive" }, { status: 400 });
    }
    const result = await receiveBatch(admin, shop.id, params.id!, lineUpdates, idempotencyKey);
    if (result.success) {
      return json({ redirect: `/app/purchase-orders/${params.id}` });
    }
    return json({ success: false, error: result.error }, { status: 400 });
  } else if (intent === "order" || intent === "orderAndPrint") {
    if (po.status !== "DRAFT") throw new Response("Already ordered", { status: 400 });
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { status: "ORDERED", orderedAt: new Date() },
    });
    if (intent === "orderAndPrint") {
      return json({ success: true, poId: po.id, openPrint: true });
    }
  } else if (intent === "cancel") {
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { status: "CANCELED" },
    });
  } else if (intent === "delete") {
    if (po.status !== "DRAFT") {
      return json({ success: false, error: "Can only delete draft purchase orders" }, { status: 400 });
    }
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { deletedAt: new Date() },
    });
    return json({ redirect: "/app/purchase-orders" });
  } else if (intent === "deleteLine") {
    if (po.status !== "DRAFT") throw new Response("Can only edit draft PO", { status: 400 });
    const lineId = String(formData.get("lineId") || "");
    await prisma.purchaseOrderLine.deleteMany({
      where: { id: lineId, purchaseOrderId: po.id },
    });
  } else if (intent === "deleteSelected") {
    if (po.status !== "DRAFT") throw new Response("Can only edit draft PO", { status: 400 });
    const lineIds = formData.getAll("lineId") as string[];
    if (lineIds.length > 0) {
      await prisma.purchaseOrderLine.deleteMany({
        where: { id: { in: lineIds }, purchaseOrderId: po.id },
      });
    }
  } else if (intent === "bulkAddLines") {
    if (po.status !== "DRAFT") return json({ redirect: `/app/purchase-orders/${po.id}` });
    const payloadJson = formData.get("payload");
    const payload = payloadJson ? (JSON.parse(String(payloadJson)) as Array<{ variantId: string; quantity: number }>) : [];
    if (!payload.length) return json({ redirect: `/app/purchase-orders/${po.id}` });

    for (const { variantId, quantity } of payload) {
      if (!variantId || quantity < 1) continue;
      const variant = await prisma.variant.findFirst({
        where: { id: variantId, shopId: shop.id },
        include: { variantSuppliers: { where: { supplierId: po.supplierId }, take: 1 } },
      });
      if (!variant) continue;
      const vs = variant.variantSuppliers[0];
      await prisma.purchaseOrderLine.upsert({
        where: { purchaseOrderId_variantId: { purchaseOrderId: po.id, variantId } },
        create: {
          purchaseOrderId: po.id,
          variantId,
          orderedQty: quantity,
          unitCost: vs?.cost ?? null,
        },
        update: { orderedQty: { increment: quantity }, unitCost: vs?.cost ?? undefined },
      });
    }
    return json({ redirect: `/app/purchase-orders/${po.id}` });
  } else if (intent === "addLine") {
    if (po.status !== "DRAFT") throw new Response("Can only edit draft PO", { status: 400 });
    const variantId = String(formData.get("variantId") || "").trim();
    const orderedQty = parseInt(String(formData.get("orderedQty") || "1"), 10);
    const unitCost = String(formData.get("unitCost") || "").trim() || null;

    if (!variantId || orderedQty < 1) return json({ redirect: `/app/purchase-orders/${po.id}` });

    const variant = await prisma.variant.findFirst({
      where: { id: variantId, shopId: shop.id },
      include: { variantSuppliers: { where: { supplierId: po.supplierId }, take: 1 } },
    });
    if (!variant) return json({ redirect: `/app/purchase-orders/${po.id}` });

    const vs = variant.variantSuppliers[0];
    await prisma.purchaseOrderLine.upsert({
      where: { purchaseOrderId_variantId: { purchaseOrderId: po.id, variantId } },
      create: {
        purchaseOrderId: po.id,
        variantId,
        orderedQty,
        unitCost: (unitCost || vs?.cost) ?? null,
      },
      update: { orderedQty: { increment: orderedQty }, unitCost: unitCost ?? undefined },
    });
  } else if (intent === "regenerate") {
    if (po.status !== "DRAFT") return json({ redirect: `/app/purchase-orders/${po.id}` });
    const locationId = (String(formData.get("locationId") || "").trim() || po.receivingLocationId) ?? shop.primaryWarehouseLocationId;
    const mode = (formData.get("forecastMode") || "SUGGESTION") as ForecastMode;
    const forecastDays = parseInt(String(formData.get("forecastDays") || "30"), 10);
    const startDateStr = String(formData.get("forecastStartDate") || "").trim();
    const endDateStr = String(formData.get("forecastEndDate") || "").trim();
    const startDate = startDateStr ? new Date(startDateStr) : undefined;
    const endDate = endDateStr ? new Date(endDateStr) : undefined;

    if (!locationId) return json({ redirect: `/app/purchase-orders/${po.id}` });

    const lines = await generatePOLinesFromForecast(shop.id, {
      supplierId: po.supplierId,
      locationId,
      mode,
      forecastDays,
      startDate,
      endDate,
    });

    for (const line of lines) {
      await prisma.purchaseOrderLine.upsert({
        where: { purchaseOrderId_variantId: { purchaseOrderId: po.id, variantId: line.variantId } },
        create: {
          purchaseOrderId: po.id,
          variantId: line.variantId,
          orderedQty: line.quantity,
          unitCost: line.unitCost,
        },
        update: { orderedQty: line.quantity, unitCost: line.unitCost ?? undefined },
      });
    }
  } else if (intent === "updateNotes") {
    if (po.deletedAt) return json({ success: false, error: "Cannot edit a deleted purchase order" }, { status: 403 });
    if (po.status === "CANCELED") {
      return json({ success: false, error: "Cannot edit a canceled purchase order" }, { status: 400 });
    }
    const notes = String(formData.get("notes") || "").trim() || null;
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { notes },
    });
  } else if (intent === "importCSV") {
    if (po.status !== "DRAFT") return json({ redirect: `/app/purchase-orders/${po.id}` });
    const csvText = String(formData.get("csvText") || "");
    const { parsePOLinesCSV, importPOLines } = await import("../services/csv-import.server");
    const rows = parsePOLinesCSV(csvText);
    if (rows.length === 0) return { success: false, error: "No valid rows" };
    await importPOLines(shop.id, po.id, rows);
  } else if (intent === "updateLine") {
    if (po.status !== "DRAFT") return json({ redirect: `/app/purchase-orders/${po.id}` });
    const lineId = String(formData.get("lineId") || "");
    const unitCost = String(formData.get("unitCost") || "").trim() || null;
    const orderedQty = parseInt(String(formData.get("orderedQty") || "0"), 10);

    const line = await prisma.purchaseOrderLine.findFirst({
      where: { id: lineId, purchaseOrderId: po.id },
    });
    if (line) {
      await prisma.purchaseOrderLine.update({
        where: { id: lineId },
        data: { unitCost, ...(orderedQty >= 0 && { orderedQty }) },
      });
    }
  } else if (intent === "updateReceived") {
    if (!["ORDERED", "PARTIALLY_RECEIVED"].includes(po.status)) {
      return json({ success: false, error: "Cannot edit received quantities when purchase order is fully received" }, { status: 400 });
    }
    const lineId = String(formData.get("lineId") || "");
    const receivedQty = parseInt(String(formData.get("receivedQty") || "0"), 10);

    const line = await prisma.purchaseOrderLine.findFirst({
      where: { id: lineId, purchaseOrderId: po.id },
    });
    if (line && !Number.isNaN(receivedQty) && receivedQty >= 0 && receivedQty <= line.orderedQty) {
      const result = await reconcileReceivedQty(shop.id, po.id, [{ lineId, receivedQty }]);
      if (!result.success) {
        return json({ success: false, error: result.error }, { status: 400 });
      }
    }
  }

  return json({ redirect: `/app/purchase-orders/${po.id}` });
};

function formatCurrency(n: number): string {
  return n.toFixed(2);
}

function getLineStatusBadge(receivedQty: number, orderedQty: number, pending: number) {
  if (receivedQty >= orderedQty) return <Badge tone="success">received</Badge>;
  if (receivedQty > 0 && pending > 0) return <Badge tone="attention">backorder</Badge>;
  return <Badge tone="subdued">not received</Badge>;
}

export default function PurchaseOrderDetail() {
  const {
    po,
    lineRows = [],
    locations = [],
    variantOptionsForAdd = [],
    subtotal = 0,
    primaryWarehouse,
    shopDomain,
  } = useLoaderData<typeof loader>() ?? {};
  const navigation = useNavigation();

  if (!po) {
    return null;
  }
  const [searchParams, setSearchParams] = useSearchParams();
  const isDraft = po.status === "DRAFT";
  const canReceive = ["ORDERED", "PARTIALLY_RECEIVED"].includes(po.status);
  const isDeleted = !!po.deletedAt;

  const supplierAddress = formatAddress({
    address1: po.supplier.address1 ?? undefined,
    address2: po.supplier.address2 ?? undefined,
    city: po.supplier.city ?? undefined,
    provinceCode: po.supplier.provinceCode ?? undefined,
    zip: po.supplier.zip ?? undefined,
    countryCode: po.supplier.countryCode ?? "US",
  });

  useEffect(() => {
    if (searchParams.get("openPrint") !== "1") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/app/purchase-orders/${po.id}/print`);
        if (!res.ok || cancelled) return;
        const html = await res.text();
        if (cancelled) return;
        const blob = new Blob([html], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } finally {
        if (!cancelled) {
          setSearchParams((p) => {
            const n = new URLSearchParams(p);
            n.delete("openPrint");
            return n;
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams, po.id, setSearchParams]);

  const [addProductsModalOpen, setAddProductsModalOpen] = useState(false);
  const [forecastMode, setForecastMode] = useState<ForecastMode>("SUGGESTION");
  const [forecastLocationId, setForecastLocationId] = useState(po.receivingLocationId ?? "");
  const [forecastDays, setForecastDays] = useState("30");
  const [forecastStartDate, setForecastStartDate] = useState("");
  const [forecastEndDate, setForecastEndDate] = useState("");
  const [selectedLineIds, setSelectedLineIds] = useState<Set<string>>(new Set());
  const [receiveModalOpen, setReceiveModalOpen] = useState(false);
  const [receiveModalQuantities, setReceiveModalQuantities] = useState<Record<string, string>>({});
  const [lineToDelete, setLineToDelete] = useState<{ id: string; label: string } | null>(null);
  const [deleteSelectedOpen, setDeleteSelectedOpen] = useState(false);
  const [deletePoOpen, setDeletePoOpen] = useState(false);
  const [printLoading, setPrintLoading] = useState(false);
  const receiveFetcher = useFetcher<{ redirect?: string; error?: string }>();
  const deleteLineFetcher = useFetcher<{ redirect?: string }>();
  const deleteSelectedFetcher = useFetcher<{ redirect?: string }>();
  const deletePoFetcher = useFetcher<{ redirect?: string; error?: string; success?: boolean }>();
  const confirmSendFetcher = useFetcher<{ success?: boolean; poId?: string; openPrint?: boolean }>();
  const cancelFetcher = useFetcher<{ redirect?: string }>();
  const forecastFetcher = useFetcher<{ redirect?: string }>();
  const updateLineFetcher = useFetcher<{ redirect?: string }>();
  const updateReceivedFetcher = useFetcher<{ redirect?: string }>();
  const restoreFetcher = useFetcher<{ redirect?: string }>();
  const notesFetcher = useFetcher<{ redirect?: string }>();
  const navigate = useNavigate();
  const confirmSendNavigated = useRef(false);

  const redirectFetchers = [
    receiveFetcher,
    deleteLineFetcher,
    deleteSelectedFetcher,
    deletePoFetcher,
    cancelFetcher,
    forecastFetcher,
    updateLineFetcher,
    updateReceivedFetcher,
    restoreFetcher,
    notesFetcher,
  ];

  useEffect(() => {
    for (const f of redirectFetchers) {
      const data = f.data as { redirect?: string } | undefined;
      if (data?.redirect && f.state === "idle") {
        setReceiveModalOpen(false);
        navigate(data.redirect);
        return;
      }
    }
  }, [
    receiveFetcher.data,
    receiveFetcher.state,
    deleteLineFetcher.data,
    deleteLineFetcher.state,
    deleteSelectedFetcher.data,
    deleteSelectedFetcher.state,
    deletePoFetcher.data,
    deletePoFetcher.state,
    cancelFetcher.data,
    cancelFetcher.state,
    forecastFetcher.data,
    forecastFetcher.state,
    updateLineFetcher.data,
    updateLineFetcher.state,
    updateReceivedFetcher.data,
    updateReceivedFetcher.state,
    restoreFetcher.data,
    restoreFetcher.state,
    notesFetcher.data,
    notesFetcher.state,
    navigate,
  ]);

  useEffect(() => {
    const data = confirmSendFetcher.data;
    if (
      data?.success &&
      data?.poId &&
      data?.openPrint &&
      confirmSendFetcher.state === "idle" &&
      !confirmSendNavigated.current
    ) {
      confirmSendNavigated.current = true;
      navigate(`/app/purchase-orders/${data.poId}?openPrint=1&justConfirmed=1`);
    }
  }, [confirmSendFetcher.data, confirmSendFetcher.state, navigate]);

  const locationOptions = [
    { label: primaryWarehouse?.name ?? "Select location", value: "" },
    ...locations.map((l) => ({ label: l.name, value: l.id })),
  ];

  const selectableLines = isDeleted ? [] : (isDraft ? lineRows : lineRows.filter((r) => r.pending > 0));
  const allSelected = selectableLines.length > 0 && selectableLines.every((r) => selectedLineIds.has(r.id));
  const someSelected = selectedLineIds.size > 0;

  const toggleLine = (lineId: string) => {
    setSelectedLineIds((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  };
  const toggleAll = () => {
    if (allSelected) setSelectedLineIds(new Set());
    else setSelectedLineIds(new Set(selectableLines.map((r) => r.id)));
  };

  const handleDeleteLineConfirm = () => {
    if (!lineToDelete) return;
    const formData = new FormData();
    formData.set("intent", "deleteLine");
    formData.set("lineId", lineToDelete.id);
    deleteLineFetcher.submit(formData, { method: "post" });
    setLineToDelete(null);
  };

  const handleOpenReceiveModal = () => {
    const initial: Record<string, string> = {};
    for (const id of selectedLineIds) {
      const row = lineRows.find((r) => r.id === id);
      if (row && row.pending > 0) initial[id] = String(row.pending);
    }
    setReceiveModalQuantities(initial);
    setReceiveModalOpen(true);
  };

  const handleReceiveModalQtyChange = (lineId: string, value: string) => {
    setReceiveModalQuantities((prev) => ({ ...prev, [lineId]: value }));
  };

  const handleReceiveSelectedSubmit = () => {
    const formData = new FormData();
    formData.append("intent", "receiveSelected");
    formData.append("idempotencyKey", `receive-batch-${crypto.randomUUID()}`);
    for (const id of selectedLineIds) {
      const row = lineRows.find((r) => r.id === id);
      if (row && row.pending > 0) {
        formData.append("lineId", id);
        formData.append(`qty_${id}`, receiveModalQuantities[id] ?? String(row.pending));
      }
    }
    receiveFetcher.submit(formData, { method: "post" });
  };

  const receiveModalTotal = Array.from(selectedLineIds).reduce((sum, id) => {
    const row = lineRows.find((r) => r.id === id);
    if (!row || row.pending <= 0) return sum;
    const qty = parseInt(receiveModalQuantities[id] ?? String(row.pending), 10);
    return sum + (Number.isNaN(qty) ? 0 : Math.max(0, Math.min(qty, row.pending)));
  }, 0);

  const handleDeletePoConfirm = () => {
    const formData = new FormData();
    formData.set("intent", "delete");
    deletePoFetcher.submit(formData, { method: "post" });
    setDeletePoOpen(false);
  };

  const handleDeleteSelectedConfirm = () => {
    const formData = new FormData();
    formData.set("intent", "deleteSelected");
    for (const id of selectedLineIds) {
      formData.append("lineId", id);
    }
    deleteSelectedFetcher.submit(formData, { method: "post" });
    setDeleteSelectedOpen(false);
    setSelectedLineIds(new Set());
  };

  const handleOpenPrint = async () => {
    setPrintLoading(true);
    try {
      const res = await fetch(`/app/purchase-orders/${po.id}/print`);
      if (!res.ok) return;
      const html = await res.text();
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } finally {
      setPrintLoading(false);
    }
  };

  const rows = lineRows.map((r) => {
    const isSelectable = isDraft || r.pending > 0;
    const checked = selectedLineIds.has(r.id);
    const productDisplay = `${r.productTitle} | ${r.variantTitle}`;
    return [
      isSelectable ? (
        <Checkbox
          key={`cb-${r.id}`}
          label=""
          labelHidden
          checked={checked}
          onChange={() => toggleLine(r.id)}
          ariaLabel={`Select line ${r.productTitle}`}
        />
      ) : (
        <Box key={`cb-${r.id}`} as="span" paddingInlineStart="100" />
      ),
      productDisplay,
      r.sku || "—",
      ...(isDraft && !isDeleted ? [] : [getLineStatusBadge(r.receivedQty, r.orderedQty, r.pending)]),
      r.unitCost || "—",
      formatCurrency(Number(r.total) || 0),
      r.onHand,
      r.onOrder,
      ...(isDraft && !isDeleted
        ? [
            <updateLineFetcher.Form key={r.id} method="post" style={{ display: "inline-flex", gap: "4px" }}>
              <input type="hidden" name="intent" value="updateLine" />
              <input type="hidden" name="lineId" value={r.id} />
              <input
                type="number"
                name="orderedQty"
                defaultValue={r.orderedQty}
                min={0}
                style={{ width: "60px", padding: "4px" }}
                onBlur={(e) => e.currentTarget.form?.requestSubmit()}
              />
            </updateLineFetcher.Form>,
            <Button
              key={`del-${r.id}`}
              icon={DeleteIcon}
              variant="plain"
              tone="critical"
              size="slim"
              accessibilityLabel="Delete line"
              onClick={() => setLineToDelete({ id: r.id, label: productDisplay })}
            />,
          ]
        : [
            r.orderedQty,
            !isDraft && !isDeleted && po.status !== "RECEIVED" ? (
              <updateReceivedFetcher.Form key={r.id} method="post" style={{ display: "inline-flex" }}>
                <input type="hidden" name="intent" value="updateReceived" />
                <input type="hidden" name="lineId" value={r.id} />
                <input
                  type="number"
                  name="receivedQty"
                  defaultValue={r.receivedQty}
                  min={0}
                  max={r.orderedQty}
                  style={{ width: "60px", padding: "4px" }}
                  onBlur={(e) => e.currentTarget.form?.requestSubmit()}
                />
              </updateReceivedFetcher.Form>
            ) : (
              r.receivedQty
            ),
            r.pending,
          ]),
    ];
  });

  const canOrder = isDraft && po.lines.length > 0;

  const receiveButtonLabel = canReceive && someSelected ? `Receive & Sync Selected (${selectedLineIds.size})` : "Receive";

  return (
    <PageShell
      title={formatPoDisplayNumber(po.poNumber)}
      backAction={{ onAction: () => navigate(isDeleted ? "/app/purchase-orders/deleted" : "/app/purchase-orders") }}
      primaryAction={
        !isDeleted && canReceive && !someSelected
          ? { content: "Receive", onAction: () => navigate(`/app/purchase-orders/${po.id}/receive`) }
          : undefined
      }
    >
      <div className="po-detail">
        <BlockStack gap="300">
          {/* Header: PO number, supplier, status | actions (Print, Confirm & Send) */}
          <div className="po-detail-header">
            <div className="po-detail-header-meta">
              <span className="po-id">{formatPoDisplayNumber(po.poNumber)}</span>
              <Text as="span" variant="bodyMd" tone="subdued">
                {po.supplier.name}
              </Text>
              <Badge tone={STATUS_TONE[po.status] ?? "info"}>
                {po.status.replace(/_/g, " ")}
              </Badge>
              {po.receivingLocation && (
                <Text as="span" variant="bodyMd" tone="subdued">
                  → {po.receivingLocation.name}
                </Text>
              )}
            </div>
            <InlineStack gap="200">
              {!isDeleted && canOrder && (
                <confirmSendFetcher.Form method="post" className="po-confirm-form">
                  <input type="hidden" name="intent" value="orderAndPrint" />
                  <Button variant="primary" submit size="slim" loading={confirmSendFetcher.state !== "idle"}>
                    Confirm & Send
                  </Button>
                </confirmSendFetcher.Form>
              )}
              {!isDeleted && isDraft && (
                <Button
                  variant="secondary"
                  tone="critical"
                  size="slim"
                  onClick={() => setDeletePoOpen(true)}
                >
                  Delete
                </Button>
              )}
              {!isDeleted && !isDraft && (
                <>
                  {po.status === "RECEIVED" && (
                    <Button
                      onClick={() => navigate(`/app/purchase-orders/${po.id}/receive?tab=reconcile`)}
                      size="slim"
                    >
                      Edit received quantities
                    </Button>
                  )}
                  <Button onClick={handleOpenPrint} loading={printLoading} size="slim">
                    Download/Print
                  </Button>
                  {!["RECEIVED", "CANCELED"].includes(po.status) && (
                    <cancelFetcher.Form method="post" style={{ display: "inline" }}>
                      <input type="hidden" name="intent" value="cancel" />
                      <Button variant="secondary" tone="critical" submit size="slim" loading={cancelFetcher.state !== "idle"}>
                        Cancel PO
                      </Button>
                    </cancelFetcher.Form>
                  )}
                </>
              )}
            </InlineStack>
          </div>

          {/* Deleted banner */}
          {isDeleted && (
            <Banner
              tone="warning"
              title="This purchase order was deleted"
              action={{
                content: "Restore",
                onAction: () => {
                  const formData = new FormData();
                  formData.set("intent", "restore");
                  restoreFetcher.submit(formData, { method: "post" });
                },
                loading: restoreFetcher.state !== "idle",
              }}
            >
              <Text as="p" variant="bodyMd">
                It is kept for your records. You can view details but cannot edit or receive. Restore to add it back to the main list{po.status === "RECEIVED" ? " and re-add inventory to Shopify" : ""}.
              </Text>
            </Banner>
          )}

          {/* Status banner - Purchase order confirmed (only right after user presses Confirm) */}
          {!isDeleted && ["ORDERED", "PARTIALLY_RECEIVED"].includes(po.status) && searchParams.get("justConfirmed") === "1" && (
            <Banner tone="success" title="Purchase order confirmed">
              <Text as="p" variant="bodyMd">
                Your purchase order has been confirmed and is awaiting delivery. Receive items when they arrive to update your Shopify stock.
              </Text>
            </Banner>
          )}

          {/* Supplier + ship-to */}
          <div className="po-parties">
            <div className="po-party-card">
              <Card>
                <div className="po-party-card-inner">
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingMd">
                        Supplier
                      </Text>
                      {!isDeleted && (
                        <Button
                          variant="plain"
                          onClick={() => navigate(`/app/suppliers/${po.supplierId}`)}
                        >
                          View supplier
                        </Button>
                      )}
                    </InlineStack>
                    <BlockStack gap="100">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">
                        {po.supplier.name}
                      </Text>
                      {po.supplier.email && (
                        <Text as="p" variant="bodyMd">
                          {po.supplier.email}
                        </Text>
                      )}
                      {po.supplier.phone && (
                        <Text as="p" variant="bodyMd">
                          {po.supplier.phone}
                        </Text>
                      )}
                      {supplierAddress ? (
                        <Text as="p" variant="bodyMd" tone="subdued">
                          {supplierAddress.split("\n").map((line, i) => (
                            <span key={i}>
                              {i > 0 && <br />}
                              {line}
                            </span>
                          ))}
                        </Text>
                      ) : (
                        <Text as="p" variant="bodySm" tone="subdued">
                          No address on file — add one on the supplier page.
                        </Text>
                      )}
                    </BlockStack>
                  </BlockStack>
                </div>
              </Card>
            </div>
            <div className="po-party-card">
              <Card>
                <div className="po-party-card-inner">
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingMd">
                      Ship to
                    </Text>
                    <BlockStack gap="100">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">
                        {shopDomain?.replace(/\.myshopify\.com$/i, "") || "Your store"}
                      </Text>
                      <Text as="p" variant="bodyMd">
                        {po.receivingLocation?.name ??
                          primaryWarehouse?.name ??
                          "No receiving location set"}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {shopDomain}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Goods will be received into this location in Shopify.
                      </Text>
                    </BlockStack>
                  </BlockStack>
                </div>
              </Card>
            </div>
          </div>

        {/* Forecast section (draft only) */}
        {!isDeleted && isDraft && (
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                Forecast
              </Text>
              <forecastFetcher.Form method="post" className="po-forecast-form">
                <input type="hidden" name="intent" value="regenerate" />
                <input type="hidden" name="forecastMode" value={forecastMode} />
                <InlineStack gap="300" wrap>
                  <div style={{ minWidth: "200px" }}>
                    <Select
                      label="Forecast type"
                      options={FORECAST_MODE_OPTIONS}
                      value={forecastMode}
                      onChange={(v) => setForecastMode(v as ForecastMode)}
                    />
                  </div>
                  <div style={{ minWidth: "200px" }}>
                    <Select
                      label="Forecast location"
                      options={locationOptions.map((o) => ({ label: o.label, value: o.value || "_empty" }))}
                      value={forecastLocationId || "_empty"}
                      onChange={(v) => setForecastLocationId(v === "_empty" ? "" : v)}
                    />
                    <input type="hidden" name="locationId" value={forecastLocationId} />
                  </div>
                  {forecastMode !== "CUSTOM" && (
                    <div style={{ minWidth: "140px" }}>
                      <TextField
                        label="Suggest for (days)"
                        type="number"
                        name="forecastDays"
                        value={forecastDays}
                        onChange={setForecastDays}
                        min={1}
                        max={365}
                        autoComplete="off"
                      />
                    </div>
                  )}
                  {forecastMode === "CUSTOM" && (
                    <>
                      <div style={{ minWidth: "160px" }}>
                        <TextField
                          label="Start date"
                          type="date"
                          name="forecastStartDate"
                          value={forecastStartDate}
                          onChange={setForecastStartDate}
                          autoComplete="off"
                        />
                      </div>
                      <div style={{ minWidth: "160px" }}>
                        <TextField
                          label="End date"
                          type="date"
                          name="forecastEndDate"
                          value={forecastEndDate}
                          onChange={setForecastEndDate}
                          autoComplete="off"
                        />
                      </div>
                    </>
                  )}
                  <div style={{ alignSelf: "flex-end" }}>
                    <Button submit loading={forecastFetcher.state !== "idle"}>Regenerate</Button>
                  </div>
                </InlineStack>
              </forecastFetcher.Form>
            </BlockStack>
          </Card>
        )}

        {/* Line items + Add product */}
        <div className={isDraft ? "po-lines-card po-lines-card--draft" : "po-lines-card"}>
        <Card>
          <BlockStack gap="300">
            {!isDeleted && isDraft && (
              <div className="po-add-product-row">
                <Button onClick={() => setAddProductsModalOpen(true)}>
                  Select products to add
                </Button>
                <AddProductsModal
                  open={addProductsModalOpen}
                  onClose={() => setAddProductsModalOpen(false)}
                  onSuccess={() => setAddProductsModalOpen(false)}
                  variants={variantOptionsForAdd}
                  actionUrl={`/app/purchase-orders/${po.id}?index`}
                />
              </div>
            )}
            <div className="po-lines-table-and-receive">
            <DataTable
              columnContentTypes={
                isDraft && !isDeleted
                  ? ["text", "text", "text", "text", "text", "numeric", "numeric", "numeric", "numeric", "text"]
                  : ["text", "text", "text", "text", "text", "text", "numeric", "numeric", "numeric", "numeric", "numeric"]
              }
              headings={
                isDraft && !isDeleted
                  ? [
                      selectableLines.length > 0 ? (
                        <Checkbox key="all" label="" labelHidden checked={allSelected} onChange={toggleAll} ariaLabel="Select all" />
                      ) : (
                        ""
                      ),
                      "Product",
                      "SKU",
                      "Cost (base)",
                      "Total (base)",
                      "Stock",
                      "On Order",
                      "Quantity",
                      <Button
                        key="bulk-delete"
                        icon={DeleteIcon}
                        variant="plain"
                        tone="critical"
                        disabled={!someSelected}
                        onClick={() => someSelected && setDeleteSelectedOpen(true)}
                        accessibilityLabel={someSelected ? `Delete selected (${selectedLineIds.size})` : "Delete selected"}
                      />,
                    ]
                  : [
                      selectableLines.length > 0 ? (
                        <Checkbox key="all" label="" labelHidden checked={allSelected} onChange={toggleAll} ariaLabel="Select all" />
                      ) : (
                        ""
                      ),
                      "Product",
                      "SKU",
                      "Status",
                      "Cost (base)",
                      "Total (base)",
                      "Stock",
                      "On Order",
                      "Ordered",
                      "Received",
                      "Pending",
                    ]
              }
              rows={rows}
            />
            {!isDeleted && canReceive && (
              <div className="po-receive-button-row">
                <InlineStack align="end">
                  {!someSelected ? (
                    <Button
                      onClick={() => navigate(`/app/purchase-orders/${po.id}/receive`)}
                      variant="primary"
                      size="slim"
                    >
                      Receive
                    </Button>
                  ) : (
                    <Button variant="primary" onClick={handleOpenReceiveModal}>
                      {receiveButtonLabel}
                    </Button>
                  )}
                </InlineStack>
              </div>
            )}
            </div>
            <div className="po-totals-compact">
              <Text as="span" variant="bodyMd" tone="subdued">
                Total
              </Text>
              <Text as="span" variant="bodyMd" fontWeight="semibold">
                ${formatCurrency(subtotal)}
              </Text>
            </div>
          </BlockStack>
        </Card>
        </div>

        {/* Notes */}
        <Card>
          <notesFetcher.Form method="post">
            <input type="hidden" name="intent" value="updateNotes" />
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                Notes
              </Text>
              {!isDeleted && po.status !== "CANCELED" ? (
                <>
                  <textarea
                    name="notes"
                    defaultValue={po.notes ?? ""}
                    rows={4}
                    placeholder="Delivery instructions, packing notes, or anything for your records…"
                    className="Polaris-TextField__Input"
                    style={{ width: "100%", minHeight: "96px", resize: "vertical", padding: "12px" }}
                  />
                  <Box>
                    <Button submit loading={notesFetcher.state !== "idle"}>
                      Save notes
                    </Button>
                  </Box>
                </>
              ) : (
                <Text as="p" variant="bodyMd" tone="subdued">
                  {po.notes?.trim() ? po.notes : "No notes"}
                </Text>
              )}
            </BlockStack>
          </notesFetcher.Form>
        </Card>

        {deletePoOpen && (
          <Modal
            open={deletePoOpen}
            onClose={() => setDeletePoOpen(false)}
            title="Delete purchase order"
            primaryAction={{
              content: "Delete",
              destructive: true,
              onAction: handleDeletePoConfirm,
              loading: deletePoFetcher.state !== "idle",
            }}
            secondaryActions={[{ content: "Cancel", onAction: () => setDeletePoOpen(false) }]}
          >
            <Modal.Section>
              <p>
                Delete {formatPoDisplayNumber(po.poNumber)}? It will be removed from the main list and kept in
                Deleted for your records. No inventory will change in Shopify.
              </p>
            </Modal.Section>
          </Modal>
        )}

        {deleteSelectedOpen && (
          <Modal
            open={deleteSelectedOpen}
            onClose={() => setDeleteSelectedOpen(false)}
            title="Remove selected line items"
            primaryAction={{
              content: "Remove",
              destructive: true,
              onAction: handleDeleteSelectedConfirm,
              loading: deleteSelectedFetcher.state !== "idle",
            }}
            secondaryActions={[{ content: "Cancel", onAction: () => setDeleteSelectedOpen(false) }]}
          >
            <Modal.Section>
              <p>
                This action is permanent. Are you sure you want to remove {selectedLineIds.size} item{selectedLineIds.size !== 1 ? "s" : ""} from this purchase order? This cannot be undone.
              </p>
            </Modal.Section>
          </Modal>
        )}

        {lineToDelete && (
          <Modal
            open={!!lineToDelete}
            onClose={() => setLineToDelete(null)}
            title="Remove line item"
            primaryAction={{
              content: "Remove",
              destructive: true,
              onAction: handleDeleteLineConfirm,
              loading: deleteLineFetcher.state !== "idle",
            }}
            secondaryActions={[{ content: "Cancel", onAction: () => setLineToDelete(null) }]}
          >
            <Modal.Section>
              <p>
                This action is permanent. Are you sure you want to remove &quot;{lineToDelete.label}&quot; from this purchase order? This cannot be undone.
              </p>
            </Modal.Section>
          </Modal>
        )}

        {receiveModalOpen && (
          <Modal
            open={receiveModalOpen}
            onClose={() => setReceiveModalOpen(false)}
            title="Receive selected items"
            primaryAction={{
              content: `Receive & Sync (${receiveModalTotal} units)`,
              destructive: false,
              onAction: handleReceiveSelectedSubmit,
              loading: receiveFetcher.state !== "idle",
              disabled: receiveModalTotal < 1,
            }}
            secondaryActions={[
              {
                content: "Receive full page",
                onAction: () => {
                  setReceiveModalOpen(false);
                  navigate(`/app/purchase-orders/${po.id}/receive`);
                },
              },
              { content: "Cancel", onAction: () => setReceiveModalOpen(false) },
            ]}
          >
            <Modal.Section>
              <BlockStack gap="300">
                <Text as="p" variant="bodyMd" tone="subdued">
                  Enter quantity to receive per line. Stock will sync to Shopify.
                </Text>
                {receiveFetcher.data && "error" in receiveFetcher.data && (
                  <Banner tone="critical" onDismiss={() => {}}>
                    {receiveFetcher.data.error}
                  </Banner>
                )}
                <DataTable
                  columnContentTypes={["text", "text", "numeric", "numeric"]}
                  headings={["Product", "SKU", "Pending", "Receive qty"]}
                  rows={Array.from(selectedLineIds)
                    .filter((id) => {
                      const row = lineRows.find((r) => r.id === id);
                      return row && row.pending > 0;
                    })
                    .map((id) => {
                      const row = lineRows.find((r) => r.id === id)!;
                      const qty = receiveModalQuantities[id] ?? String(row.pending);
                      return [
                        `${row.productTitle} | ${row.variantTitle}`,
                        row.sku || "—",
                        row.pending,
                        <TextField
                          key={id}
                          label=""
                          labelHidden
                          type="number"
                          value={qty}
                          onChange={(v) => handleReceiveModalQtyChange(id, v)}
                          min={0}
                          max={row.pending}
                          autoComplete="off"
                        />,
                      ];
                    })}
                />
              </BlockStack>
            </Modal.Section>
          </Modal>
        )}

        </BlockStack>
      </div>
    </PageShell>
  );
}
