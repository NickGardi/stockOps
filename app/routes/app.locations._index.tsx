import type { LoaderFunctionArgs } from "@remix-run/node";
import { Link, useLoaderData, useNavigate } from "@remix-run/react";
import {
  Card,
  DataTable,
  Button,
  BlockStack,
  EmptyState,
  Badge,
  InlineStack,
  Text,
} from "@shopify/polaris";
import { PageShell } from "../components/PageShell";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { locations: [] };

  const [locations, levels] = await Promise.all([
    prisma.location.findMany({
      where: { shopId: shop.id },
      orderBy: { name: "asc" },
    }),
    prisma.inventoryLevel.findMany({
      where: { shopId: shop.id },
      select: { locationId: true, available: true },
    }),
  ]);

  const statsByLocation = new Map<string, { totalUnits: number; variantsWithStock: number }>();
  for (const l of levels) {
    let entry = statsByLocation.get(l.locationId);
    if (!entry) {
      entry = { totalUnits: 0, variantsWithStock: 0 };
      statsByLocation.set(l.locationId, entry);
    }
    entry.totalUnits += l.available;
    if (l.available > 0) entry.variantsWithStock++;
  }

  const locationsWithStats = locations.map((loc) => ({
    ...loc,
    totalUnits: statsByLocation.get(loc.id)?.totalUnits ?? 0,
    variantsWithStock: statsByLocation.get(loc.id)?.variantsWithStock ?? 0,
  }));

  return { locations: locationsWithStats };
};

export default function LocationsList() {
  const { locations } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const rows = locations.map((loc) => [
    <Link key={loc.id} to={`/app/locations/${loc.id}`}>
      {loc.name}
    </Link>,
    loc.totalUnits.toLocaleString(),
    loc.variantsWithStock,
    loc.isActive ? (
      <Badge key={`badge-${loc.id}`} tone="success">
        Active
      </Badge>
    ) : (
      <Badge key={`badge-${loc.id}`} tone="subdued">
        Inactive
      </Badge>
    ),
    <Button key={loc.id} size="slim" variant="plain" onClick={() => navigate(`/app/locations/${loc.id}`)}>
      Edit
    </Button>,
  ]);

  return (
    <PageShell title="Locations" primaryAction={{ content: "Add location", url: "/app/locations/new" }}>
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="400">
            <Text as="p" variant="bodyMd" tone="subdued">
              Locations are synced from your Shopify store. You can also create, edit, or deactivate them here — changes sync to Shopify.
            </Text>
            {locations.length === 0 ? (
              <EmptyState
                heading="No locations yet"
                action={{ content: "Add location", url: "/app/locations/new" }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Create a location or run Resync in Settings to pull locations from your Shopify store.</p>
              </EmptyState>
            ) : (
              <>
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Locations
                  </Text>
                  <Button variant="primary" url="/app/locations/new">
                    Add location
                  </Button>
                </InlineStack>
                <DataTable
                  columnContentTypes={["text", "numeric", "numeric", "text", "text"]}
                  headings={["Name", "Units in stock", "Variants", "Status", ""]}
                  rows={rows}
                  hasZebraStripingOnData
                />
              </>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </PageShell>
  );
}
