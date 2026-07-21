import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import { useState, useEffect } from "react";
import { Layout, Card, Button, BlockStack, Text, Banner, Select } from "@shopify/polaris";
import { PageShell } from "../components/PageShell";
import { authenticate } from "../shopify.server";
import { fullSync } from "../services/sync.server";
import { backfillOrders } from "../services/orders-backfill.server";
import prisma from "../db.server";

function extractErrorMessage(err: unknown): string {
  const toStr = (v: unknown): string => {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "object") {
      const s = String(v);
      if (s === "[object Object]") return JSON.stringify(v).slice(0, 200);
      if (s === "[object Response]") return "Sync failed. Please try again.";
      return s;
    }
    return String(v);
  };
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof Response !== "undefined" && err instanceof Response) {
    return err.status === 401 || err.status === 403
      ? "Session expired. Please refresh the page and try again."
      : "Sync failed. Please try again.";
  }
  if (typeof err === "object" && err !== null) {
    const o = err as Record<string, unknown>;
    if (typeof o.message === "string") return o.message;
    const msg = toStr(o.message);
    if (msg && msg !== "[object Object]") return msg;
    if (Array.isArray(o.errors)) return o.errors.map((e) => toStr(typeof e === "object" && e !== null && "message" in e ? (e as { message: unknown }).message : e)).filter(Boolean).join("; ");
  }
  return toStr(err) || "Sync failed";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
    include: { primaryWarehouseLocation: true },
  });
  if (!shop) return { productCount: 0, variantCount: 0, locationCount: 0, locations: [], primaryWarehouse: null, primaryWarehouseInvalid: false };

  const [productCount, variantCount, locationCount, locations] = await Promise.all([
    prisma.product.count({ where: { shopId: shop.id } }),
    prisma.variant.count({ where: { shopId: shop.id } }),
    prisma.location.count({ where: { shopId: shop.id } }),
    prisma.location.findMany({ where: { shopId: shop.id, isActive: true }, select: { id: true, name: true } }),
  ]);

  const primaryWarehouseInvalid =
    !!shop.primaryWarehouseLocationId &&
    (!shop.primaryWarehouseLocation || !shop.primaryWarehouseLocation.isActive);

  return { productCount, variantCount, locationCount, locations, primaryWarehouse: shop.primaryWarehouseLocation, primaryWarehouseInvalid };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { success: false, error: "Shop not found" };

  const intent = formData.get("intent");
  if (intent === "resync") {
    try {
      await fullSync(admin, shop.id);
      const ordersResult = await backfillOrders(admin, shop.id, 60);
      if (ordersResult.blocked) {
        return { success: true, orderAccessBlocked: true };
      }
      if (!ordersResult.ok) {
        console.warn("Orders backfill failed:", ordersResult.error);
        return { success: true, orderAccessBlocked: true };
      }
      return { success: true };
    } catch (err) {
      const message = extractErrorMessage(err);
      console.error("Resync failed:", err);
      return { success: false, error: message || "Sync failed" };
    }
  }

  if (intent === "setPrimaryWarehouse") {
    const locationId = formData.get("locationId");
    if (typeof locationId !== "string" || !locationId) return { success: false, error: "Location required" };
    const location = await prisma.location.findFirst({ where: { id: locationId, shopId: shop.id } });
    if (!location) return { success: false, error: "Location not found" };
    await prisma.shop.update({
      where: { id: shop.id },
      data: { primaryWarehouseLocationId: locationId },
    });
    return { success: true };
  }

  return { success: false, error: "Invalid intent" };
};

export default function Settings() {
  const navigate = useNavigate();
  const fetcher = useFetcher<typeof action>();
  const primaryWarehouseFetcher = useFetcher<typeof action>();
  const { productCount, variantCount, locationCount, locations, primaryWarehouse, primaryWarehouseInvalid } = useLoaderData<typeof loader>();
  const isLoading = fetcher.state !== "idle";
  const success = fetcher.data?.success;
  const error = fetcher.data?.error;
  const orderAccessBlocked = fetcher.data?.orderAccessBlocked;

  const [dismissedSuccess, setDismissedSuccess] = useState(false);
  const [dismissedOrderBlocked, setDismissedOrderBlocked] = useState(false);
  const [dismissedError, setDismissedError] = useState(false);

  // Reset dismissed state when we get new success/error from fetcher
  useEffect(() => {
    if (success !== undefined) {
      setDismissedSuccess(false);
      setDismissedOrderBlocked(false);
    }
    if (error !== undefined) setDismissedError(false);
  }, [success, error]);

  // Auto-dismiss success banners after 10 seconds
  useEffect(() => {
    if (!success || dismissedSuccess || dismissedOrderBlocked) return;
    const timer = setTimeout(() => {
      if (orderAccessBlocked) setDismissedOrderBlocked(true);
      else setDismissedSuccess(true);
    }, 10000);
    return () => clearTimeout(timer);
  }, [success, orderAccessBlocked, dismissedSuccess, dismissedOrderBlocked]);

  return (
    <PageShell title="Settings">
      <BlockStack gap="500">
        {success && !orderAccessBlocked && !dismissedSuccess && (
          <Banner tone="success" onDismiss={() => setDismissedSuccess(true)}>
            Resync completed successfully.
          </Banner>
        )}
        {success && orderAccessBlocked && !dismissedOrderBlocked && (
          <Banner tone="warning" onDismiss={() => setDismissedOrderBlocked(true)}>
            Products and inventory synced, but sales history could not be loaded. Approve Order access
            (Protected Customer Data) in the Partner Dashboard so StockOps can read paid orders.{" "}
            <a href="https://shopify.dev/docs/apps/launch/protected-customer-data" target="_blank" rel="noreferrer">
              Request access
            </a>
            .
          </Banner>
        )}
        {error && !dismissedError && (
          <Banner tone="critical" onDismiss={() => setDismissedError(true)}>
            {typeof error === "string" && !error.startsWith("[object") ? error : "Sync failed. Please try again."}
          </Banner>
        )}
        {primaryWarehouseInvalid && (
          <Banner tone="critical" title={primaryWarehouse ? `${primaryWarehouse.name} is no longer available` : "Receiving location no longer available"}>
            {primaryWarehouse ? `${primaryWarehouse.name} was deleted or deactivated in Shopify.` : "Your receiving location was deleted or deactivated in Shopify."} Select a new one below.
          </Banner>
        )}
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Receiving location
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Reorder suggestions and PO receiving use this location.                   Create or edit locations in <Link to="/app/locations">Locations</Link>. Run Resync below to pull in
                  locations from Shopify.
                </Text>
                <primaryWarehouseFetcher.Form method="post">
                  <input type="hidden" name="intent" value="setPrimaryWarehouse" />
                  <BlockStack gap="300">
                    <Select
                      label="Location"
                      options={[
                        { label: "Select location", value: "" },
                        ...locations.map((l) => ({ label: l.name, value: l.id })),
                      ]}
                      value={primaryWarehouse?.id ?? ""}
                      onChange={(value) => {
                        if (value) {
                          const formData = new FormData();
                          formData.set("intent", "setPrimaryWarehouse");
                          formData.set("locationId", value);
                          primaryWarehouseFetcher.submit(formData, { method: "post" });
                        }
                      }}
                    />
                    {primaryWarehouse && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        Reorder suggestions use inventory from {primaryWarehouse.name}.
                      </Text>
                    )}
                  </BlockStack>
                </primaryWarehouseFetcher.Form>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Billing
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  StockOps is $10/month after a 30-day free trial. Manage your subscription on the Billing page.
                </Text>
                <Button onClick={() => navigate("/app/billing")}>Manage billing</Button>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Data Sync
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Products: {productCount} · Variants (SKUs): {variantCount} · Locations: {locationCount}
                </Text>
                <Text as="p" variant="bodyMd">
                  Resync all products, variants, locations, and inventory levels from Shopify.
                  Use this if data is out of date.
                </Text>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="resync" />
                  <Button variant="primary" submit loading={isLoading} disabled={isLoading}>
                    Resync
                  </Button>
                </fetcher.Form>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </PageShell>
  );
}
