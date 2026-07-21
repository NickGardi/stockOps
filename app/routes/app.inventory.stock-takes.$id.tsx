import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useLoaderData,
  useNavigation,
  useActionData,
  redirect,
  Form,
} from "@remix-run/react";
import {
  Page,
  Card,
  DataTable,
  Button,
  BlockStack,
  Text,
  InlineStack,
  Badge,
  Banner,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const STATUS_TONE: Record<string, "info" | "success" | "warning" | "critical"> = {
  DRAFT: "info",
  IN_PROGRESS: "warning",
  COMPLETED: "success",
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const stockTake = await prisma.stockTake.findFirst({
    where: { id: params.id!, shopId: shop.id },
    include: {
      location: true,
      lines: { include: { variant: { include: { product: true } } } },
    },
  });
  if (!stockTake) throw new Response("Not found", { status: 404 });

  return { stockTake };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const stockTake = await prisma.stockTake.findFirst({
    where: { id: params.id!, shopId: shop.id },
  });
  if (!stockTake) throw new Response("Not found", { status: 404 });

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "generate") {
    if (stockTake.status !== "DRAFT") return redirect(`/app/inventory/stock-takes/${stockTake.id}`);
    const levels = await prisma.inventoryLevel.findMany({
      where: {
        locationId: stockTake.locationId,
        available: { gt: 0 },
        variant: {
          shopId,
          inventoryTracked: true,
          product: {
            deletedAt: null,
            status: { notIn: ["DRAFT", "ARCHIVED"] },
          },
        },
      },
      include: { variant: true },
    });
    for (const il of levels) {
      await prisma.stockTakeLine.upsert({
        where: {
          stockTakeId_variantId: { stockTakeId: stockTake.id, variantId: il.variantId },
        },
        create: {
          stockTakeId: stockTake.id,
          variantId: il.variantId,
          expectedQty: il.available,
          countedQty: il.available,
        },
        update: { expectedQty: il.available },
      });
    }
  } else if (intent === "start") {
    if (stockTake.status !== "DRAFT") return redirect(`/app/inventory/stock-takes/${stockTake.id}`);
    await prisma.stockTake.update({
      where: { id: stockTake.id },
      data: { status: "IN_PROGRESS" },
    });
  } else if (intent === "finish") {
    for (const [key, value] of formData.entries()) {
      if (key.startsWith("counted_")) {
        const lineId = key.slice(8);
        const countedQty = parseInt(String(value), 10);
        if (!Number.isNaN(countedQty) && countedQty >= 0) {
          await prisma.stockTakeLine.updateMany({
            where: { id: lineId, stockTakeId: stockTake.id },
            data: { countedQty },
          });
        }
      }
    }
    const { finishStockTake } = await import("../services/stock-take.server");
    const result = await finishStockTake(admin, shop.id, stockTake.id);
    if (!result.success) return { success: false, error: result.error ?? "Failed to finish" };
  } else if (intent === "updateLine") {
    const lineId = String(formData.get("lineId") || "");
    const countedQty = parseInt(String(formData.get("countedQty") || "0"), 10);

    const line = await prisma.stockTakeLine.findFirst({
      where: { id: lineId, stockTakeId: stockTake.id },
    });
    if (line) {
      await prisma.stockTakeLine.update({
        where: { id: lineId },
        data: { countedQty },
      });
    }
  }
  return redirect(`/app/inventory/stock-takes/${stockTake.id}`);
};

export default function StockTakeDetail() {
  const { stockTake } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const actionData = useActionData<{ success?: boolean; error?: string }>();
  const [counted, setCounted] = useState<Record<string, string>>({});

  const updateCounted = (lineId: string, value: string) => {
    setCounted((prev) => ({ ...prev, [lineId]: value }));
  };

  const rows = stockTake.lines.map((l) => {
    const val = counted[l.id] ?? String(l.countedQty);
    const count = parseInt(val, 10) || 0;
    return [
      l.variant.product.title,
      l.variant.title,
      l.variant.sku || "—",
      l.expectedQty,
      <input
        key={l.id}
        type="number"
        value={val}
        onChange={(e) => updateCounted(l.id, e.target.value)}
        min={0}
        className="Polaris-TextField__Input"
        style={{ width: "80px" }}
      />,
      count - l.expectedQty,
    ];
  });

  const canStart = stockTake.status === "DRAFT" && stockTake.lines.length > 0;
  const canFinish = stockTake.status === "IN_PROGRESS";

  return (
    <Page>
      <TitleBar
        title={stockTake.name}
        backAction={{ url: "/app/inventory/stock-takes" }}
      />
      <BlockStack gap="400">
        {actionData?.error && (
          <Banner tone="critical" onDismiss={() => {}}>
            {actionData.error}
          </Banner>
        )}
        <Card>
          <BlockStack gap="200">
            <InlineStack gap="300" blockAlign="center">
              <Text as="h2" variant="headingMd">
                {stockTake.location.name}
              </Text>
              <Badge tone={STATUS_TONE[stockTake.status] ?? "info"}>
                {stockTake.status.replace(/_/g, " ")}
              </Badge>
            </InlineStack>
            <InlineStack gap="300">
              {canStart && (
                <Form method="post">
                  <input type="hidden" name="intent" value="start" />
                  <Button variant="primary" submit loading={navigation.state !== "idle"}>
                    Start counting
                  </Button>
                </Form>
              )}
              {canFinish && (
                <Text as="p" variant="bodyMd" tone="subdued">
                  Use the Finish button below the table to apply adjustments.
                </Text>
              )}
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h3" variant="headingMd">
              Lines
            </Text>
            {stockTake.status === "DRAFT" && stockTake.lines.length === 0 && (
              <Form method="post">
                <input type="hidden" name="intent" value="generate" />
                <Button submit loading={navigation.state !== "idle"}>
                  Generate lines from location
                </Button>
              </Form>
            )}
            {stockTake.lines.length === 0 && stockTake.status !== "DRAFT" ? (
              <Text as="p" variant="bodyMd" tone="subdued">
                No lines.
              </Text>
            ) : stockTake.lines.length > 0 ? (
              <Form method="post">
                <input type="hidden" name="intent" value="finish" />
                {stockTake.lines.map((l) => (
                  <input
                    key={l.id}
                    type="hidden"
                    name={`counted_${l.id}`}
                    value={counted[l.id] ?? l.countedQty}
                  />
                ))}
                <DataTable
                  columnContentTypes={["text", "text", "text", "numeric", "numeric", "numeric"]}
                  headings={["Product", "Variant", "SKU", "Expected", "Counted", "Delta"]}
                  rows={rows}
                />
                {canFinish && (
                  <div style={{ marginTop: "1rem" }}>
                    <Button variant="primary" submit loading={navigation.state !== "idle"}>
                      Finish and apply adjustments
                    </Button>
                  </div>
                )}
              </Form>
            ) : null}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
