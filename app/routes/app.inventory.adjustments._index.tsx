import type { LoaderFunctionArgs } from "@remix-run/node";
import { Link, useLoaderData, useLocation } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Button,
  DataTable,
  EmptyState,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { adjustments: [] };

  const adjustments = await prisma.stockAdjustment.findMany({
    where: { shopId: shop.id },
    include: {
      location: true,
      lines: true,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return { adjustments };
};

export default function AdjustmentsList() {
  const { adjustments } = useLoaderData<typeof loader>();
  const location = useLocation();
  const search = location.search || "";

  const rows = adjustments.map((a) => [
    a.location.name,
    a.reasonCode || "—",
    a.lines.reduce((sum, l) => sum + Math.abs(l.quantityDelta), 0),
    a.performedAt ? new Date(a.performedAt).toLocaleDateString() : "Pending",
    <Link key={a.id} to={`/app/inventory/adjustments/${a.id}${search}`}>
      View
    </Link>,
  ]);

  return (
    <Page>
      <TitleBar
        title="Stock Adjustments"
        primaryAction={{ content: "New adjustment", url: `/app/inventory/adjustments/new${search}` }}
      />
      <BlockStack gap="400">
        <Card>
          {adjustments.length === 0 ? (
            <EmptyState
              heading="No adjustments yet"
              action={{
                content: "Create adjustment",
                url: `/app/inventory/adjustments/new${search}`,
              }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>Manually correct inventory levels.</p>
            </EmptyState>
          ) : (
            <DataTable
              columnContentTypes={["text", "text", "numeric", "text", "text"]}
              headings={["Location", "Reason", "Lines", "Performed", ""]}
              rows={rows}
            />
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
