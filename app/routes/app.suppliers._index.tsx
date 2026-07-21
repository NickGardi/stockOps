import type { LoaderFunctionArgs } from "@remix-run/node";
import { Link, useLoaderData, useNavigate } from "@remix-run/react";
import { Card, DataTable, Button, BlockStack, EmptyState, Badge, InlineStack, Text } from "@shopify/polaris";
import { PageShell } from "../components/PageShell";
import { formatAddress } from "../lib/address";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getIncompleteCountBySupplier } from "../services/supplier-assignment.server";
import "../styles/suppliers-list-table.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { suppliers: [], incompleteBySupplier: {} };

  const [suppliers, incompleteMap] = await Promise.all([
    prisma.supplier.findMany({
      where: { shopId: shop.id },
      orderBy: { name: "asc" },
      include: { _count: { select: { variantSuppliers: true } } },
    }),
    getIncompleteCountBySupplier(shop.id),
  ]);

  const incompleteBySupplier = Object.fromEntries(incompleteMap);
  return { suppliers, incompleteBySupplier };
};

export default function SuppliersList() {
  const { suppliers, incompleteBySupplier } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const rows = suppliers.map((s) => {
    const incompleteCount = incompleteBySupplier[s.id];
    const hasIncomplete = incompleteCount != null && incompleteCount > 0;
    const statusBadge = hasIncomplete ? (
      <Badge key={s.id} tone="warning">
        {incompleteCount} need{incompleteCount === 1 ? "s" : ""} info
      </Badge>
    ) : (
      <Badge key={s.id} tone="success">
        Complete
      </Badge>
    );

    return [
      <Link key={s.id} to={`/app/suppliers/${s.id}`}>
        {s.name}
      </Link>,
      s._count.variantSuppliers,
      s.email || "—",
      s.phone || "—",
      formatAddress({
        address1: s.address1,
        address2: s.address2,
        city: s.city,
        provinceCode: s.provinceCode,
        zip: s.zip,
        countryCode: s.countryCode || "US",
      }) || "—",
      statusBadge,
      <Button key={s.id} size="slim" variant="plain" onClick={() => navigate(`/app/suppliers/${s.id}`)}>
        Edit
      </Button>,
    ];
  });

  return (
    <PageShell title="Suppliers" primaryAction={{ content: "Add supplier", url: "/app/suppliers/new" }}>
      <BlockStack gap="400">
        {suppliers.length === 0 ? (
          <Card>
            <EmptyState
              heading="Add your first supplier"
              action={{ content: "Add supplier", url: "/app/suppliers/new" }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>Suppliers help you track who you order from and manage purchase orders.</p>
            </EmptyState>
          </Card>
        ) : (
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Suppliers
                </Text>
                <Button variant="primary" url="/app/suppliers/new">
                  Add supplier
                </Button>
              </InlineStack>
              <div className="suppliers-list-table">
                <DataTable
                columnContentTypes={["text", "numeric", "text", "text", "text", "text", "text"]}
                headings={["Name", "SKUs", "Email", "Phone", "Address", "Status", ""]}
                  rows={rows}
                  hasZebraStripingOnData
                />
              </div>
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </PageShell>
  );
}
