import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData, useNavigation, Form } from "@remix-run/react";
import {
  Page,
  Card,
  FormLayout,
  Select,
  TextField,
  Button,
  BlockStack,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const transfer = await prisma.stockTransfer.findFirst({
    where: { id: params.id!, shopId: shop.id },
    include: { sourceLocation: true, destLocation: true },
  });
  if (!transfer || transfer.status !== "DRAFT") throw new Response("Not found", { status: 404 });

  const variantsWithStock = await prisma.variant.findMany({
    where: {
      shopId: shop.id,
      inventoryTracked: true,
      inventoryLevels: {
        some: {
          locationId: transfer.sourceLocationId,
          available: { gt: 0 },
        },
      },
    },
    include: {
      product: true,
      inventoryLevels: {
        where: { locationId: transfer.sourceLocationId },
        take: 1,
      },
    },
    orderBy: [{ product: { title: "asc" } }, { title: "asc" }],
  });

  const variantOptions = variantsWithStock.map((v) => {
    const avail = v.inventoryLevels[0]?.available ?? 0;
    return {
      label: `${v.product.title} - ${v.title} (${avail} at source)`,
      value: v.id,
    };
  });

  return { transfer, variantOptions };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const transfer = await prisma.stockTransfer.findFirst({
    where: { id: params.id!, shopId: shop.id },
  });
  if (!transfer || transfer.status !== "DRAFT") throw new Response("Not found", { status: 404 });

  const formData = await request.formData();
  const variantId = String(formData.get("variantId") || "");
  const quantity = parseInt(String(formData.get("quantity") || "0"), 10);

  if (!variantId || quantity < 1) {
    return redirect(`/app/inventory/transfers/${transfer.id}/add-line`);
  }

  await prisma.stockTransferLine.upsert({
    where: {
      stockTransferId_variantId: { stockTransferId: transfer.id, variantId },
    },
    create: {
      stockTransferId: transfer.id,
      variantId,
      quantity,
    },
    update: { quantity: { increment: quantity } },
  });

  return redirect(`/app/inventory/transfers/${transfer.id}`);
};

export default function AddTransferLine() {
  const { transfer, variantOptions } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const [variantId, setVariantId] = useState("");
  const [quantity, setQuantity] = useState("1");

  return (
    <Page>
      <TitleBar
        title="Add line"
        backAction={{ url: `/app/inventory/transfers/${transfer.id}` }}
      />
      <BlockStack gap="400">
        <Card>
          <Form method="post">
            <FormLayout>
              <input type="hidden" name="variantId" value={variantId} />
              <Select
                label="Variant"
                options={[
                  { label: "Select variant (with stock at source)", value: "" },
                  ...variantOptions,
                ]}
                value={variantId}
                onChange={setVariantId}
              />
              <TextField
                label="Quantity"
                name="quantity"
                type="number"
                value={quantity}
                onChange={setQuantity}
                min={1}
                autoComplete="off"
              />
              <Button
                variant="primary"
                submit
                disabled={!variantId || !quantity || parseInt(quantity, 10) < 1}
                loading={navigation.state !== "idle"}
              >
                Add
              </Button>
            </FormLayout>
          </Form>
        </Card>
      </BlockStack>
    </Page>
  );
}
