import type { LoaderFunctionArgs } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Button,
  DataTable,
  Badge,
  EmptyState,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const STATUS_TONE: Record<string, "info" | "success" | "warning" | "critical"> = {
  DRAFT: "info",
  IN_PROGRESS: "warning",
  COMPLETED: "success",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { stockTakes: [] };

  const stockTakes = await prisma.stockTake.findMany({
    where: { shopId: shop.id },
    include: { location: true },
    orderBy: { createdAt: "desc" },
  });

  return { stockTakes };
};

export default function StockTakesList() {
  const { stockTakes } = useLoaderData<typeof loader>();

  const rows = stockTakes.map((t) => [
    t.name,
    t.location.name,
    t.mode,
    <Badge key={t.id} tone={STATUS_TONE[t.status] ?? "info"}>
      {t.status.replace(/_/g, " ")}
    </Badge>,
    <Link key={t.id} to={`/app/inventory/stock-takes/${t.id}`}>
      View
    </Link>,
  ]);

  return (
    <Page>
      <TitleBar
        title="Stock Takes"
        primaryAction={{ content: "New stock take", url: "/app/inventory/stock-takes/new" }}
      />
      <BlockStack gap="400">
        <Card>
          {stockTakes.length === 0 ? (
            <EmptyState
              heading="No stock takes yet"
              action={{
                content: "Create stock take",
                url: "/app/inventory/stock-takes/new",
              }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>Count inventory at a location and create adjustments.</p>
            </EmptyState>
          ) : (
            <DataTable
              columnContentTypes={["text", "text", "text", "text", "text"]}
              headings={["Name", "Location", "Mode", "Status", ""]}
              rows={rows}
            />
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
