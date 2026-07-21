import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import {
  Card,
  FormLayout,
  Select,
  Button,
  BlockStack,
  Banner,
  TextField,
} from "@shopify/polaris";
import { PageShell } from "../components/PageShell";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  generatePOLinesFromForecast,
  type ForecastMode,
} from "../services/forecast.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
    include: { primaryWarehouseLocation: true },
  });
  if (!shop)
    return { suppliers: [], locations: [], primaryLocationId: null };

  const [suppliers, locations] = await Promise.all([
    prisma.supplier.findMany({
      where: { shopId: shop.id },
      orderBy: { name: "asc" },
    }),
    prisma.location.findMany({
      where: { shopId: shop.id, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  const primaryLocationId = shop.primaryWarehouseLocation?.id ?? null;
  const primaryLocationName = shop.primaryWarehouseLocation?.name ?? null;

  return {
    suppliers,
    locations,
    primaryLocationId,
    primaryLocationName,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { success: false, error: "Shop not found" };

  const formData = await request.formData();
  const supplierId = String(formData.get("supplierId") || "").trim();
  if (!supplierId) return { success: false, error: "Supplier required" };

  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, shopId: shop.id },
  });
  if (!supplier) return { success: false, error: "Supplier not found" };

  const receivingLocationId = String(
    formData.get("receivingLocationId") || ""
  ).trim();
  const mode = (formData.get("forecastMode") || "BLANK") as ForecastMode;
  const forecastDays = parseInt(
    String(formData.get("forecastDays") || "30"),
    10
  );
  const startDateStr = String(formData.get("forecastStartDate") || "").trim();
  const endDateStr = String(formData.get("forecastEndDate") || "").trim();
  const startDate = startDateStr ? new Date(startDateStr) : undefined;
  const endDate = endDateStr ? new Date(endDateStr) : undefined;

  const locationId =
    receivingLocationId ||
    (shop.primaryWarehouseLocationId ?? undefined);
  if (!locationId)
    return { success: false, error: "Receiving location required. Select a location in Settings." };

  const { getNextPoNumber } = await import("../services/purchase-order.server");
  const poNumber = await getNextPoNumber(shop.id);
  const po = await prisma.purchaseOrder.create({
    data: {
      shopId: shop.id,
      supplierId: supplier.id,
      status: "DRAFT",
      receivingLocationId: receivingLocationId || null,
      poNumber,
    },
  });

  if (mode !== "BLANK") {
    const lines = await generatePOLinesFromForecast(shop.id, {
      supplierId,
      locationId,
      mode,
      forecastDays,
      startDate,
      endDate,
    });

    for (const line of lines) {
      await prisma.purchaseOrderLine.create({
        data: {
          purchaseOrderId: po.id,
          variantId: line.variantId,
          orderedQty: line.quantity,
          unitCost: line.unitCost,
        },
      });
    }
  }

  return json({ redirect: `/app/purchase-orders/${po.id}` });
};

const FORECAST_MODE_OPTIONS: { label: string; value: ForecastMode }[] = [
  { label: "Blank (manual add only)", value: "BLANK" },
  {
    label: "Suggestion (forecast from sales velocity, respect min/max)",
    value: "SUGGESTION",
  },
  { label: "Same period last year", value: "YOY" },
  { label: "Fill shelves (min/max only)", value: "FILL_SHELVES" },
  { label: "Fill shelves (if below min)", value: "FILL_SHELVES_IF_BELOW_MIN" },
  { label: "Target stock (min/max target)", value: "TARGET_STOCK" },
  { label: "Custom date range", value: "CUSTOM" },
];

export default function NewPurchaseOrder() {
  const {
    suppliers,
    locations,
    primaryLocationId,
    primaryLocationName,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean; error?: string; redirect?: string }>();
  const navigate = useNavigate();
  const [supplierId, setSupplierId] = useState("");
  const [receivingLocationId, setReceivingLocationId] = useState(
    primaryLocationId ?? ""
  );
  const [forecastMode, setForecastMode] = useState<ForecastMode>("BLANK");
  const [forecastDays, setForecastDays] = useState("30");
  const [forecastStartDate, setForecastStartDate] = useState("");
  const [forecastEndDate, setForecastEndDate] = useState("");

  useEffect(() => {
    if (primaryLocationId && !receivingLocationId) {
      setReceivingLocationId(primaryLocationId);
    }
  }, [primaryLocationId, receivingLocationId]);

  useEffect(() => {
    const data = fetcher.data as { redirect?: string } | undefined;
    if (data?.redirect && fetcher.state === "idle") {
      navigate(data.redirect);
    }
  }, [fetcher.data, fetcher.state, navigate]);

  const error =
    fetcher.data && !fetcher.data.success ? fetcher.data.error : null;
  const supplierOptions = suppliers.map((s) => ({ label: s.name, value: s.id }));
  const locationOptions = [
    { label: "Select location", value: "" },
    ...locations.map((l) => ({ label: l.name, value: l.id })),
  ];
  const showForecastOptions = forecastMode !== "BLANK";

  return (
    <PageShell title="Create PO" backAction={{ url: "/app/purchase-orders" }}>
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" onDismiss={() => {}}>
            {error}
          </Banner>
        )}
        <Card>
          <fetcher.Form method="post">
            <FormLayout>
              <input type="hidden" name="supplierId" value={supplierId} />
              <input
                type="hidden"
                name="receivingLocationId"
                value={receivingLocationId}
              />
              <input type="hidden" name="forecastMode" value={forecastMode} />
              <input type="hidden" name="forecastDays" value={forecastDays} />
              <input type="hidden" name="forecastStartDate" value={forecastStartDate} />
              <input type="hidden" name="forecastEndDate" value={forecastEndDate} />

              <Select
                label="Supplier"
                options={[
                  { label: "Select supplier", value: "" },
                  ...supplierOptions,
                ]}
                value={supplierId}
                onChange={setSupplierId}
              />

              <Select
                label="Receiving location"
                options={locationOptions}
                value={receivingLocationId}
                onChange={setReceivingLocationId}
                helpText={primaryLocationName ? `Pre-selected: ${primaryLocationName}` : undefined}
              />

              <Select
                label="Forecast mode"
                options={FORECAST_MODE_OPTIONS}
                value={forecastMode}
                onChange={(v) => setForecastMode(v as ForecastMode)}
              />

              {showForecastOptions && forecastMode !== "CUSTOM" && (
                <TextField
                  label="Forecast days"
                  type="number"
                  value={forecastDays}
                  onChange={setForecastDays}
                  autoComplete="off"
                  min={1}
                  max={365}
                  helpText="Used for suggestion/YOY mode (sales velocity window)"
                />
              )}
              {showForecastOptions && forecastMode === "CUSTOM" && (
                <FormLayout.Group>
                  <TextField
                    label="Start date"
                    type="date"
                    value={forecastStartDate}
                    onChange={setForecastStartDate}
                    autoComplete="off"
                  />
                  <TextField
                    label="End date"
                    type="date"
                    value={forecastEndDate}
                    onChange={setForecastEndDate}
                    autoComplete="off"
                  />
                </FormLayout.Group>
              )}

              <Button
                variant="primary"
                submit
                disabled={!supplierId || fetcher.state !== "idle"}
                loading={fetcher.state !== "idle"}
              >
                Create
              </Button>
            </FormLayout>
          </fetcher.Form>
        </Card>
      </BlockStack>
    </PageShell>
  );
}
