import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  FormLayout,
  Select,
  TextField,
  Button,
  BlockStack,
  Banner,
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
    include: { supplier: true },
  });
  if (!po || po.status !== "DRAFT") throw new Response("Not found", { status: 404 });

  const variants = await prisma.variant.findMany({
    where: {
      shopId: shop.id,
      variantSuppliers: { some: { supplierId: po.supplierId } },
    },
    include: {
      product: true,
      variantSuppliers: { where: { supplierId: po.supplierId }, take: 1 },
    },
    orderBy: [{ product: { title: "asc" } }, { title: "asc" }],
  });

  const { hasCompleteSupplierDetails } = await import("../services/supplier-assignment.server");
  const variantOptions = variants.map((v) => {
    const vs = v.variantSuppliers[0];
    const hasCost = vs && hasCompleteSupplierDetails({ cost: vs.cost, leadTimeDays: vs.leadTimeDays });
    return {
      label: `${v.product.title} - ${v.title}${v.sku ? ` (${v.sku})` : ""}`,
      value: v.id,
      hasCost,
    };
  });
  const incompleteVariantIds = variantOptions.filter((o) => !o.hasCost).map((o) => o.value);
  return { po, variantOptions, incompleteVariantIds };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: params.id!, shopId: shop.id },
  });
  if (!po || po.status !== "DRAFT") throw new Response("Not found", { status: 404 });

  const formData = await request.formData();
  const variantId = String(formData.get("variantId") || "");
  const orderedQty = parseInt(String(formData.get("orderedQty") || "0"), 10);
  const unitCost = String(formData.get("unitCost") || "").trim() || null;

  if (!variantId || orderedQty < 1) throw new Response("Variant and quantity required", { status: 400 });

  const variant = await prisma.variant.findFirst({
    where: { id: variantId, shopId: shop.id },
    include: { variantSuppliers: { take: 1 } },
  });
  if (!variant) throw new Response("Variant not found", { status: 404 });

  const vs = variant.variantSuppliers[0];
  const { hasCompleteSupplierDetails } = await import("../services/supplier-assignment.server");
  const hasCost = vs && hasCompleteSupplierDetails({ cost: vs.cost, leadTimeDays: vs.leadTimeDays });
  if (!hasCost && !unitCost) {
    return json({ error: "Enter unit cost to add this variant, or add cost and lead time on the supplier page first." }, { status: 400 });
  }

  await prisma.purchaseOrderLine.upsert({
    where: {
      purchaseOrderId_variantId: { purchaseOrderId: po.id, variantId: variant.id },
    },
    create: {
      purchaseOrderId: po.id,
      variantId: variant.id,
      orderedQty,
      unitCost: unitCost || vs?.cost || null,
    },
    update: {
      orderedQty: { increment: orderedQty },
      unitCost: unitCost ?? undefined,
    },
  });

  return json({ redirect: `/app/purchase-orders/${po.id}` });
};

export default function AddLine() {
  const { po, variantOptions, incompleteVariantIds } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ error?: string; redirect?: string }>();
  const navigate = useNavigate();

  const [variantId, setVariantId] = useState("");
  const [orderedQty, setOrderedQty] = useState("1");
  const [unitCost, setUnitCost] = useState("");

  const selectedVariantIncomplete = variantId && incompleteVariantIds.includes(variantId);
  const addError = (fetcher.data as { error?: string } | undefined)?.error;

  useEffect(() => {
    const data = fetcher.data as { redirect?: string } | undefined;
    if (data?.redirect && fetcher.state === "idle") {
      navigate(data.redirect);
    }
  }, [fetcher.data, fetcher.state, navigate]);

  return (
    <Page>
      <TitleBar title="Add line" backAction={{ url: `/app/purchase-orders/${po.id}` }} />
      <BlockStack gap="400">
        {addError && (
          <Banner tone="critical" onDismiss={() => {}}>
            {addError}
          </Banner>
        )}
        {selectedVariantIncomplete && !addError && (
          <Banner tone="warning" title="This variant needs cost and lead time">
            Enter unit cost below to add this variant, or add cost and lead time on the supplier page first.
          </Banner>
        )}
        <Card>
          <fetcher.Form method="post">
            <FormLayout>
              <input type="hidden" name="variantId" value={variantId} />
              <Select
                label="Variant"
                options={[
                  { label: "Select variant", value: "" },
                  ...variantOptions.map((o) => ({
                    label: o.label,
                    value: o.value,
                  })),
                ]}
                value={variantId}
                onChange={setVariantId}
              />
              <TextField
                label="Quantity"
                name="orderedQty"
                type="number"
                value={orderedQty}
                onChange={setOrderedQty}
                min={1}
                autoComplete="off"
              />
              <TextField
                label="Unit cost"
                name="unitCost"
                value={unitCost}
                onChange={setUnitCost}
                autoComplete="off"
                helpText={selectedVariantIncomplete ? "Required — or complete supplier details first" : undefined}
              />
              <Button
                variant="primary"
                submit
                disabled={!variantId || !orderedQty || (selectedVariantIncomplete && !unitCost.trim())}
                loading={fetcher.state !== "idle"}
              >
                Add
              </Button>
            </FormLayout>
          </fetcher.Form>
        </Card>
      </BlockStack>
    </Page>
  );
}
