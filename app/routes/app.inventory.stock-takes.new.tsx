import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { locations: [] };

  const locations = await prisma.location.findMany({
    where: { shopId: shop.id, isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  return { locations };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { success: false, error: "Shop not found" };

  const formData = await request.formData();
  const locationId = String(formData.get("locationId") || "").trim();
  const name = String(formData.get("name") || "").trim() || `Stock take ${new Date().toLocaleDateString()}`;
  const mode = String(formData.get("mode") || "MANUAL");

  if (!locationId) return { success: false, error: "Location required" };

  const stockTake = await prisma.stockTake.create({
    data: {
      shopId: shop.id,
      locationId,
      name,
      mode: mode === "BARCODE" ? "BARCODE" : "MANUAL",
      status: "DRAFT",
    },
  });

  return { success: true, stockTakeId: stockTake.id };
};

export default function NewStockTake() {
  const { locations } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [locationId, setLocationId] = useState("");
  const [name, setName] = useState(`Stock take ${new Date().toLocaleDateString()}`);
  const [mode, setMode] = useState("MANUAL");

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data.stockTakeId) {
      navigate(`/app/inventory/stock-takes/${fetcher.data.stockTakeId}`);
    }
  }, [fetcher.data, navigate]);

  const error = fetcher.data && !fetcher.data.success ? fetcher.data.error : null;
  const locationOptions = locations.map((l) => ({ label: l.name, value: l.id }));

  return (
    <Page>
      <TitleBar title="New stock take" backAction={{ url: "/app/inventory/stock-takes" }} />
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" onDismiss={() => {}}>
            {error}
          </Banner>
        )}
        <Card>
          <fetcher.Form method="post">
            <FormLayout>
              <input type="hidden" name="locationId" value={locationId} />
              <input type="hidden" name="name" value={name} />
              <input type="hidden" name="mode" value={mode} />
              <TextField
                label="Name"
                value={name}
                onChange={setName}
                autoComplete="off"
              />
              <Select
                label="Location"
                options={[{ label: "Select location", value: "" }, ...locationOptions]}
                value={locationId}
                onChange={setLocationId}
              />
              <Select
                label="Mode"
                options={[
                  { label: "Manual", value: "MANUAL" },
                  { label: "Barcode", value: "BARCODE" },
                ]}
                value={mode}
                onChange={setMode}
              />
              <Button
                variant="primary"
                submit
                disabled={!locationId || fetcher.state !== "idle"}
                loading={fetcher.state !== "idle"}
              >
                Create
              </Button>
            </FormLayout>
          </fetcher.Form>
        </Card>
      </BlockStack>
    </Page>
  );
}
