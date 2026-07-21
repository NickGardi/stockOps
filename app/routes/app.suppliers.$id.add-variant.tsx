import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, redirect } from "@remix-run/react";
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
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const supplier = await prisma.supplier.findFirst({
    where: { id: params.id!, shopId: shop.id },
  });
  if (!supplier) throw new Response("Not found", { status: 404 });

  const variants = await prisma.variant.findMany({
    where: { shopId: shop.id },
    include: { product: true },
    orderBy: [{ product: { title: "asc" } }, { title: "asc" }],
  });
  const linkedIds = new Set(
    (await prisma.variantSupplier.findMany({
      where: { supplierId: supplier.id },
      select: { variantId: true },
    })).map((vs) => vs.variantId)
  );
  const availableVariants = variants.filter((v) => !linkedIds.has(v.id));

  const variantOptions = availableVariants.map((v) => ({
    label: `${v.product.title} - ${v.title}${v.sku ? ` (${v.sku})` : ""}`,
    value: v.id,
  }));

  return { supplier, variantOptions };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const supplier = await prisma.supplier.findFirst({
    where: { id: params.id!, shopId: shop.id },
  });
  if (!supplier) throw new Response("Not found", { status: 404 });

  const formData = await request.formData();
  const variantId = String(formData.get("variantId") || "");
  const cost = String(formData.get("cost") || "").trim() || null;
  const leadTimeDays = parseInt(String(formData.get("leadTimeDays") || "0"), 10) || null;

  if (!variantId) return { error: "Variant required" };

  const variant = await prisma.variant.findFirst({
    where: { id: variantId, shopId: shop.id },
  });
  if (!variant) return { error: "Variant not found" };

  try {
    await prisma.variantSupplier.create({
      data: {
        variantId: variant.id,
        supplierId: supplier.id,
        cost,
        leadTimeDays,
      },
    });
  } catch (e) {
    return { error: "Failed to add variant. It may already be assigned to a supplier." };
  }

  return redirect(`/app/suppliers/${supplier.id}`);
};

export default function AddVariantToSupplier() {
  const { supplier, variantOptions } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const [variantId, setVariantId] = useState("");
  const [cost, setCost] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState("");

  const error = fetcher.data && typeof fetcher.data === "object" && "error" in fetcher.data ? (fetcher.data as { error: string }).error : null;

  return (
    <Page>
      <TitleBar title="Add variant" backAction={{ url: `/app/suppliers/${supplier.id}` }} />
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" onDismiss={() => {}}>
            {error}
          </Banner>
        )}
        <Card>
          <fetcher.Form method="post">
            <FormLayout>
              <input type="hidden" name="variantId" value={variantId} />
              <input type="hidden" name="cost" value={cost} />
              <input type="hidden" name="leadTimeDays" value={leadTimeDays} />
              <Select
                label="Variant"
                options={[{ label: "Select variant", value: "" }, ...variantOptions]}
                value={variantId}
                onChange={setVariantId}
              />
              <TextField
                label="Cost"
                value={cost}
                onChange={setCost}
                autoComplete="off"
              />
              <TextField
                label="Lead time (days)"
                type="number"
                min={0}
                value={leadTimeDays}
                onChange={setLeadTimeDays}
                autoComplete="off"
              />
              <Button variant="primary" submit disabled={!variantId} loading={fetcher.state !== "idle"}>
                Add
              </Button>
            </FormLayout>
          </fetcher.Form>
        </Card>
      </BlockStack>
    </Page>
  );
}
