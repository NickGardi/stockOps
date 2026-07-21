import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigation, useActionData, redirect, Form } from "@remix-run/react";
import {
  Page,
  Card,
  DataTable,
  Button,
  BlockStack,
  Text,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const adjustment = await prisma.stockAdjustment.findFirst({
    where: { id: params.id!, shopId: shop.id },
    include: {
      location: true,
      lines: { include: { variant: { include: { product: true } } } },
    },
  });
  if (!adjustment) throw new Response("Not found", { status: 404 });

  return { adjustment };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const adjustment = await prisma.stockAdjustment.findFirst({
    where: { id: params.id!, shopId: shop.id },
  });
  if (!adjustment) throw new Response("Not found", { status: 404 });

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "perform" && !adjustment.performedAt) {
    const { performStockAdjustment } = await import("../services/stock-adjustment.server");
    const result = await performStockAdjustment(admin, shop.id, adjustment.id);
    if (!result.success) return { success: false, error: result.error ?? "Failed to perform" };
  }
  return redirect(`/app/inventory/adjustments/${adjustment.id}`);
};

export default function AdjustmentDetail() {
  const { adjustment } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const actionData = useActionData<{ success?: boolean; error?: string }>();

  const rows = adjustment.lines.map((l) => [
    l.variant.product.title,
    l.variant.title,
    l.variant.sku || "—",
    l.quantityDelta > 0 ? `+${l.quantityDelta}` : String(l.quantityDelta),
  ]);

  const canPerform = !adjustment.performedAt && adjustment.lines.some((l) => l.quantityDelta !== 0);

  return (
    <Page>
      <TitleBar
        title={`Adjustment ${adjustment.id.slice(-6)}`}
        backAction={{ url: "/app/inventory/adjustments" }}
      />
      <BlockStack gap="400">
        {actionData?.error && (
          <Banner tone="critical" onDismiss={() => {}}>
            {actionData.error}
          </Banner>
        )}
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              {adjustment.location.name}
            </Text>
            {adjustment.reasonCode && (
              <Text as="p" variant="bodyMd" tone="subdued">
                Reason: {adjustment.reasonCode}
              </Text>
            )}
            {adjustment.performedAt && (
              <Text as="p" variant="bodyMd" tone="subdued">
                Performed: {new Date(adjustment.performedAt).toLocaleString()}
              </Text>
            )}
            {canPerform && (
              <Form method="post">
                <input type="hidden" name="intent" value="perform" />
                <Button variant="primary" submit loading={navigation.state !== "idle"}>
                  Perform adjustment
                </Button>
              </Form>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h3" variant="headingMd">
              Lines
            </Text>
            <DataTable
              columnContentTypes={["text", "text", "text", "text"]}
              headings={["Product", "Variant", "SKU", "Delta"]}
              rows={rows}
            />
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
