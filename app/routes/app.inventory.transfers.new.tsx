import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  FormLayout,
  Select,
  Button,
  BlockStack,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getNextTransferNumber } from "../services/stock-transfer.server";

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
  const sourceLocationId = String(formData.get("sourceLocationId") || "").trim();
  const destLocationId = String(formData.get("destLocationId") || "").trim();

  if (!sourceLocationId || !destLocationId) {
    return { success: false, error: "Source and destination required" };
  }
  if (sourceLocationId === destLocationId) {
    return { success: false, error: "Source and destination must be different" };
  }

  const transferNumber = await getNextTransferNumber(shop.id);
  const transfer = await prisma.stockTransfer.create({
    data: {
      shopId: shop.id,
      sourceLocationId,
      destLocationId,
      status: "DRAFT",
      transferNumber,
    },
  });

  return { success: true, transferId: transfer.id };
};

export default function NewTransfer() {
  const { locations } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [sourceLocationId, setSourceLocationId] = useState("");
  const [destLocationId, setDestLocationId] = useState("");

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data.transferId) {
      navigate(`/app/inventory/transfers/${fetcher.data.transferId}`);
    }
  }, [fetcher.data, navigate]);

  const error = fetcher.data && !fetcher.data.success ? fetcher.data.error : null;
  const locationOptions = locations.map((l) => ({ label: l.name, value: l.id }));

  return (
    <Page>
      <TitleBar title="New transfer" backAction={{ url: "/app/inventory/transfers" }} />
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" onDismiss={() => {}}>
            {error}
          </Banner>
        )}
        <Card>
          <fetcher.Form method="post">
            <FormLayout>
              <input type="hidden" name="sourceLocationId" value={sourceLocationId} />
              <input type="hidden" name="destLocationId" value={destLocationId} />
              <Banner tone="info">
                <p>
                  Creating a transfer does not move inventory yet. After adding products, use <strong>Send</strong> to
                  deduct from the source location in Shopify, then <strong>Receive</strong> to add stock at the
                  destination. Deleting a sent or completed transfer will reverse those Shopify changes.
                </p>
              </Banner>
              <Select
                label="From (source)"
                options={[{ label: "Select location", value: "" }, ...locationOptions]}
                value={sourceLocationId}
                onChange={setSourceLocationId}
              />
              <Select
                label="To (destination)"
                options={[{ label: "Select location", value: "" }, ...locationOptions]}
                value={destLocationId}
                onChange={setDestLocationId}
              />
              <Button
                variant="primary"
                submit
                disabled={
                  !sourceLocationId ||
                  !destLocationId ||
                  sourceLocationId === destLocationId ||
                  fetcher.state !== "idle"
                }
                loading={fetcher.state !== "idle"}
              >
                Create and add lines
              </Button>
            </FormLayout>
          </fetcher.Form>
        </Card>
      </BlockStack>
    </Page>
  );
}
