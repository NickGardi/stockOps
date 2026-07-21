import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  FormLayout,
  TextField,
  Button,
  BlockStack,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: params.id!, shopId: shop.id },
  });
  if (!po || po.status !== "DRAFT") throw new Response("Not found", { status: 404 });

  const line = await prisma.purchaseOrderLine.findFirst({
    where: { id: params.lineId!, purchaseOrderId: po.id },
    include: { variant: { include: { product: true } } },
  });
  if (!line) throw new Response("Not found", { status: 404 });

  return { po, line };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: params.id!, shopId: shop.id },
  });
  if (!po || po.status !== "DRAFT") throw new Response("Not found", { status: 404 });

  const line = await prisma.purchaseOrderLine.findFirst({
    where: { id: params.lineId!, purchaseOrderId: po.id },
  });
  if (!line) throw new Response("Not found", { status: 404 });

  const formData = await request.formData();
  const orderedQty = parseInt(String(formData.get("orderedQty") || "0"), 10);
  const unitCost = String(formData.get("unitCost") || "").trim() || null;

  if (orderedQty < 0) throw new Response("Quantity must be >= 0", { status: 400 });

  await prisma.purchaseOrderLine.update({
    where: { id: line.id },
    data: { orderedQty, unitCost },
  });

  return json({ redirect: `/app/purchase-orders/${po.id}` });
};

export default function EditLine() {
  const { po, line } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ redirect?: string }>();
  const navigate = useNavigate();
  const [orderedQty, setOrderedQty] = useState(String(line.orderedQty));

  useEffect(() => {
    const data = fetcher.data as { redirect?: string } | undefined;
    if (data?.redirect && fetcher.state === "idle") {
      navigate(data.redirect);
    }
  }, [fetcher.data, fetcher.state, navigate]);
  const [unitCost, setUnitCost] = useState(line.unitCost ?? "");

  return (
    <Page>
      <TitleBar
        title="Edit line"
        backAction={{ url: `/app/purchase-orders/${po.id}` }}
      />
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">
              {line.variant.product.title} - {line.variant.title}
              {line.variant.sku ? ` (${line.variant.sku})` : ""}
            </Text>
            <fetcher.Form method="post">
              <FormLayout>
                <TextField
                  label="Quantity"
                  name="orderedQty"
                  type="number"
                  value={orderedQty}
                  onChange={setOrderedQty}
                  min={0}
                  autoComplete="off"
                />
                <TextField
                  label="Unit cost"
                  name="unitCost"
                  value={unitCost}
                  onChange={setUnitCost}
                  autoComplete="off"
                />
                <Button
                  variant="primary"
                  submit
                  loading={fetcher.state !== "idle"}
                >
                  Save
                </Button>
              </FormLayout>
            </fetcher.Form>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
