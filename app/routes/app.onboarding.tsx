import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useLoaderData, useFetcher } from "@remix-run/react";
import { Card, BlockStack, Text, List, Button, RadioButton, Banner } from "@shopify/polaris";
import { PageShell } from "../components/PageShell";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
    include: { primaryWarehouseLocation: true },
  });
  if (!shop) return { productCount: 0, supplierCount: 0, poCount: 0, locations: [], primaryWarehouse: null, needsPrimarySelection: false };

  const locations = await prisma.location.findMany({
    where: { shopId: shop.id },
    select: { id: true, name: true },
  });

  // Fallback: if single location and no primary set (e.g. sync not done yet), set it
  if (locations.length === 1 && !shop.primaryWarehouseLocationId) {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { primaryWarehouseLocationId: locations[0].id },
    });
    const updated = await prisma.shop.findUnique({
      where: { id: shop.id },
      include: { primaryWarehouseLocation: true },
    });
    return {
      productCount: await prisma.product.count({ where: { shopId: shop.id } }),
      supplierCount: await prisma.supplier.count({ where: { shopId: shop.id } }),
      poCount: await prisma.purchaseOrder.count({ where: { shopId: shop.id, deletedAt: null } }),
      locations,
      primaryWarehouse: updated?.primaryWarehouseLocation ?? null,
      needsPrimarySelection: false,
    };
  }

  const [productCount, supplierCount, poCount] = await Promise.all([
    prisma.product.count({ where: { shopId: shop.id } }),
    prisma.supplier.count({ where: { shopId: shop.id } }),
    prisma.purchaseOrder.count({ where: { shopId: shop.id, deletedAt: null } }),
  ]);

  return {
    productCount,
    supplierCount,
    poCount,
    locations,
    primaryWarehouse: shop.primaryWarehouseLocation,
    needsPrimarySelection: locations.length > 1 && !shop.primaryWarehouseLocationId,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { ok: false };

  const formData = await request.formData();
  const intent = formData.get("intent");
  if (intent !== "setPrimaryWarehouse") return { ok: false };

  const locationId = formData.get("locationId");
  if (typeof locationId !== "string" || !locationId) return { ok: false };

  const location = await prisma.location.findFirst({
    where: { id: locationId, shopId: shop.id },
  });
  if (!location) return { ok: false };

  await prisma.shop.update({
    where: { id: shop.id },
    data: { primaryWarehouseLocationId: locationId },
  });
  return { ok: true };
};

export default function Onboarding() {
  const { productCount, supplierCount, poCount, locations, primaryWarehouse, needsPrimarySelection } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean }>();
  const [selectedLocationId, setSelectedLocationId] = useState<string>("");

  const steps = [
    { done: productCount > 0, label: "Sync products and inventory", url: "/app/settings" },
    { done: supplierCount > 0, label: "Add suppliers", url: "/app/suppliers" },
    { done: false, label: "Link variants to suppliers (cost, lead time)", url: "/app/suppliers" },
    { done: poCount > 0, label: "Create your first purchase order", url: "/app/purchase-orders/new" },
  ];

  return (
    <PageShell title="Getting started" primaryAction={{ content: "Go to dashboard", url: "/app" }}>
      <BlockStack gap="400">
        <Text as="h1" variant="headingLg">
          Welcome to StockOps
        </Text>

        {needsPrimarySelection && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Where do you receive inventory from suppliers?
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Select where you receive inventory. Reorder suggestions and receiving will use this location.
              </Text>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="setPrimaryWarehouse" />
                <BlockStack gap="300">
                  {locations.map((loc) => (
                    <RadioButton
                      key={loc.id}
                      label={loc.name}
                      id={`loc-${loc.id}`}
                      name="locationId"
                      value={loc.id}
                      checked={selectedLocationId === loc.id}
                      onChange={(checked) => checked && setSelectedLocationId(loc.id)}
                    />
                  ))}
                  <Button
                    variant="primary"
                    submit
                    loading={fetcher.state !== "idle"}
                    disabled={!selectedLocationId}
                  >
                    Save and continue
                  </Button>
                </BlockStack>
              </fetcher.Form>
            </BlockStack>
          </Card>
        )}

        {primaryWarehouse && !needsPrimarySelection && (
          <Banner tone="success" title="Receiving location configured">
            {primaryWarehouse.name}
          </Banner>
        )}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Onboarding checklist
            </Text>
            <List type="number">
              {steps.map((s, i) => (
                <List.Item key={i}>
                  {s.done ? "✓ " : ""}
                  <Link to={s.url}>{s.label}</Link>
                </List.Item>
              ))}
            </List>
          </BlockStack>
        </Card>
      </BlockStack>
    </PageShell>
  );
}
