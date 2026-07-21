import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, useLoaderData, useActionData, useLocation, useNavigation } from "@remix-run/react";
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

/** Shopify inventoryAdjustQuantities valid reason codes */
export const ADJUSTMENT_REASON_OPTIONS = [
  { label: "Correction (general adjustment)", value: "correction" },
  { label: "Cycle count", value: "cycle_count_available" },
  { label: "Damaged", value: "damaged" },
  { label: "Movement canceled", value: "movement_canceled" },
  { label: "Movement created", value: "movement_created" },
  { label: "Movement received", value: "movement_received" },
  { label: "Movement updated", value: "movement_updated" },
  { label: "Other", value: "other" },
  { label: "Promotion / Donation", value: "promotion" },
  { label: "Quality control", value: "quality_control" },
  { label: "Received", value: "received" },
  { label: "Reservation created", value: "reservation_created" },
  { label: "Reservation deleted", value: "reservation_deleted" },
  { label: "Reservation updated", value: "reservation_updated" },
  { label: "Restock", value: "restock" },
  { label: "Safety stock", value: "safety_stock" },
  { label: "Shrinkage (theft/loss)", value: "shrinkage" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { locations: [], variantOptions: [] };

  const [locations, variants] = await Promise.all([
    prisma.location.findMany({
      where: { shopId: shop.id, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.variant.findMany({
      where: { shopId: shop.id, inventoryTracked: true },
      include: { product: true },
      orderBy: [{ product: { title: "asc" } }, { title: "asc" }],
      take: 500,
    }),
  ]);

  const variantOptions = variants.map((v) => ({
    label: `${v.product.title} - ${v.title}${v.sku ? ` (${v.sku})` : ""}`,
    value: v.id,
  }));

  return { locations, variantOptions };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { success: false, error: "Shop not found" };

  const formData = await request.formData();
  const locationId = String(formData.get("locationId") || "").trim();
  const reasonCode = String(formData.get("reasonCode") || "").trim() || "correction";
  const notes = String(formData.get("notes") || "").trim() || null;
  const variantId = String(formData.get("variantId") || "").trim();
  const quantityDelta = parseInt(String(formData.get("quantityDelta") || "0"), 10);

  if (!locationId) return { success: false, error: "Location required" };
  if (!variantId || quantityDelta === 0) return { success: false, error: "Variant and delta required" };

  const adjustment = await prisma.stockAdjustment.create({
    data: {
      shopId: shop.id,
      locationId,
      reasonCode,
      notes,
      lines: {
        create: { variantId, quantityDelta },
      },
    },
  });

  const { performStockAdjustment } = await import("../services/stock-adjustment.server");
  const result = await performStockAdjustment(admin, shop.id, adjustment.id);
  if (!result.success) return { success: false, error: result.error };

  return redirect(`/app/inventory/adjustments/${adjustment.id}`);
};

export default function NewAdjustment() {
  const { locations, variantOptions } = useLoaderData<typeof loader>();
  const reasonOptions = [
    { label: "Select reason", value: "" },
    ...ADJUSTMENT_REASON_OPTIONS,
  ];
  const [locationId, setLocationId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [quantityDelta, setQuantityDelta] = useState("0");
  const [reasonCode, setReasonCode] = useState("correction");
  const [notes, setNotes] = useState("");

  const actionData = useActionData<{ error?: string }>();
  const navigation = useNavigation();
  const location = useLocation();
  const error = actionData?.error ?? null;
  const isSubmitting = navigation.state === "submitting";
  const locationOptions = locations.map((l) => ({ label: l.name, value: l.id }));
  const search = location.search || "";

  return (
    <Page>
      <TitleBar title="New adjustment" backAction={{ url: `/app/inventory/adjustments${search}` }} />
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" onDismiss={() => {}}>
            {error}
          </Banner>
        )}
        <Card>
          <Form method="post" action={`/app/inventory/adjustments/new${search}`}>
            <FormLayout>
              <input type="hidden" name="locationId" value={locationId} />
              <input type="hidden" name="variantId" value={variantId} />
              <input type="hidden" name="quantityDelta" value={quantityDelta} />
              <input type="hidden" name="reasonCode" value={reasonCode} />
              <input type="hidden" name="notes" value={notes} />
              <Select
                label="Location"
                options={[{ label: "Select location", value: "" }, ...locationOptions]}
                value={locationId}
                onChange={setLocationId}
              />
              <Select
                label="Variant"
                options={[{ label: "Select variant", value: "" }, ...variantOptions]}
                value={variantId}
                onChange={setVariantId}
              />
              <TextField
                label="Quantity delta (+ or -)"
                type="number"
                value={quantityDelta}
                onChange={setQuantityDelta}
                autoComplete="off"
                helpText="Positive to add, negative to remove"
              />
              <Select
                label="Reason code"
                options={reasonOptions}
                value={reasonCode}
                onChange={setReasonCode}
              />
              <TextField
                label="Notes"
                value={notes}
                onChange={setNotes}
                autoComplete="off"
              />
              <Button
                variant="primary"
                submit
                disabled={
                  !locationId ||
                  !variantId ||
                  parseInt(quantityDelta, 10) === 0 ||
                  isSubmitting
                }
                loading={isSubmitting}
              >
                Perform adjustment
              </Button>
            </FormLayout>
          </Form>
        </Card>
      </BlockStack>
    </Page>
  );
}
