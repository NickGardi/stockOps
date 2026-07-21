import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import { useState, useEffect } from "react";
import {
  Card,
  FormLayout,
  TextField,
  Button,
  BlockStack,
  Banner,
  Select,
  Text,
  Modal,
  DataTable,
} from "@shopify/polaris";
import "../styles/location-detail.css";
import { PageShell } from "../components/PageShell";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  updateLocation,
  deactivateLocation,
  deleteLocation,
  fetchLocationFromShopify,
} from "../services/location.server";
import { AddressForm } from "../components/AddressForm";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const location = await prisma.location.findFirst({
    where: { id: params.id!, shopId: shop.id },
  });
  if (!location) throw new Response("Not found", { status: 404 });

  const inventoryLevelsRaw = await prisma.inventoryLevel.findMany({
    where: { locationId: location.id },
    include: {
      variant: {
        include: { product: true },
      },
    },
  });
  const inventoryLevels = inventoryLevelsRaw.sort((a, b) => {
    const pa = a.variant.product.title;
    const pb = b.variant.product.title;
    if (pa !== pb) return pa.localeCompare(pb);
    return a.variant.title.localeCompare(b.variant.title);
  });

  let shopifyData: Awaited<ReturnType<typeof fetchLocationFromShopify>> = null;
  try {
    shopifyData = await fetchLocationFromShopify(
      admin as Parameters<typeof fetchLocationFromShopify>[0],
      location.shopifyLocationId
    );
  } catch (err) {
    // If Shopify API fails (e.g. auth, network), still render page with DB data
    const { logger } = await import("../lib/logger.server");
    logger.warn("Failed to fetch location from Shopify", {
      locationId: location.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const otherLocations = await prisma.location.findMany({
    where: { shopId: shop.id, id: { not: location.id }, isActive: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const totalUnits = inventoryLevels.reduce((sum, il) => sum + il.available, 0);
  const variantsWithStock = inventoryLevels.filter((il) => il.available > 0).length;

  return {
    location,
    shopifyData,
    otherLocations,
    inventoryLevels,
    totalUnits,
    variantsWithStock,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return json({ success: false, error: "Shop not found" }, { status: 404 });

  const location = await prisma.location.findFirst({
    where: { id: params.id!, shopId: shop.id },
  });
  if (!location) return json({ success: false, error: "Location not found" }, { status: 404 });

  const formData = await request.formData();
  const intent = formData.get("intent");

  const adminClient = admin as Parameters<typeof updateLocation>[0];

  if (intent === "update") {
    const name = String(formData.get("name") || "").trim();
    if (!name) return json({ success: false, error: "Name required" }, { status: 400 });

    const countryCode = String(formData.get("countryCode") || "US").trim() || "US";
    const address: { countryCode: string; address1?: string; address2?: string; city?: string; provinceCode?: string; zip?: string } = {
      countryCode,
    };
    const address1 = String(formData.get("address1") || "").trim();
    const address2 = String(formData.get("address2") || "").trim();
    const city = String(formData.get("city") || "").trim();
    const provinceCode = String(formData.get("provinceCode") || "").trim();
    const zip = String(formData.get("zip") || "").trim();
    if (address1) address.address1 = address1;
    if (address2) address.address2 = address2;
    if (city) address.city = city;
    if (provinceCode) address.provinceCode = provinceCode;
    if (zip) address.zip = zip;

    const result = await updateLocation(adminClient, shop.id, location.id, { name, address });
    if (!result.success) return json({ success: false, error: result.error }, { status: 400 });
    return json({ success: true, redirect: `/app/locations/${location.id}` });
  }

  if (intent === "deactivate") {
    const destinationLocationId = String(formData.get("destinationLocationId") || "").trim();
    if (!destinationLocationId) {
      return json({ success: false, error: "Select a destination location for inventory" }, { status: 400 });
    }
    const result = await deactivateLocation(adminClient, shop.id, location.id, destinationLocationId);
    if (!result.success) return json({ success: false, error: result.error }, { status: 400 });
    return json({ success: true, redirect: `/app/locations/${location.id}` });
  }

  if (intent === "delete") {
    const result = await deleteLocation(adminClient, shop.id, location.id);
    if (!result.success) return json({ success: false, error: result.error }, { status: 400 });
    return json({ success: true, redirect: "/app/locations" });
  }

  return json({ success: false, error: "Invalid intent" }, { status: 400 });
};

export default function LocationDetail() {
  const { location, shopifyData, otherLocations, inventoryLevels, totalUnits, variantsWithStock } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean; error?: string; redirect?: string }>();
  const navigate = useNavigate();

  const [name, setName] = useState(location.name);
  const [address1, setAddress1] = useState(shopifyData?.address?.address1 ?? "");
  const [address2, setAddress2] = useState(shopifyData?.address?.address2 ?? "");
  const [city, setCity] = useState(shopifyData?.address?.city ?? "");
  const [provinceCode, setProvinceCode] = useState(shopifyData?.address?.provinceCode ?? "");
  const [zip, setZip] = useState(shopifyData?.address?.zip ?? "");
  const [countryCode, setCountryCode] = useState(shopifyData?.address?.countryCode ?? "US");
  const [deactivateModalOpen, setDeactivateModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [destinationLocationId, setDestinationLocationId] = useState(otherLocations[0]?.id ?? "");

  useEffect(() => {
    setName(location.name);
    setAddress1(shopifyData?.address?.address1 ?? "");
    setAddress2(shopifyData?.address?.address2 ?? "");
    setCity(shopifyData?.address?.city ?? "");
    setProvinceCode(shopifyData?.address?.provinceCode ?? "");
    setZip(shopifyData?.address?.zip ?? "");
    setCountryCode(shopifyData?.address?.countryCode ?? "US");
  }, [location, shopifyData]);

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.redirect && fetcher.state === "idle") {
      navigate(fetcher.data.redirect);
    }
  }, [fetcher.data, fetcher.state, navigate]);

  const error = fetcher.data && !fetcher.data.success ? fetcher.data.error : null;
  const destinationOptions = otherLocations.map((l) => ({ label: l.name, value: l.id }));

  return (
    <PageShell title={location.name} backAction={{ url: "/app/locations" }}>
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" onDismiss={() => {}}>
            {error}
          </Banner>
        )}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Inventory summary
            </Text>
            <Text as="p" variant="bodyMd">
              <strong>{totalUnits.toLocaleString()}</strong> units across <strong>{variantsWithStock}</strong>{" "}
              variant{variantsWithStock !== 1 ? "s" : ""}
            </Text>
            {inventoryLevels.length === 0 ? (
              <Text as="p" variant="bodyMd" tone="subdued">
                No inventory at this location. Run Resync in Settings to pull inventory from Shopify.
              </Text>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "numeric"]}
                headings={["Product", "Variant", "SKU", "Available"]}
                rows={inventoryLevels.map((il) => [
                  il.variant.product.title,
                  il.variant.title,
                  il.variant.sku || "—",
                  il.available,
                ])}
                hasZebraStripingOnData
              />
            )}
          </BlockStack>
        </Card>

        <div className="location-edit-card">
          <Card>
          <BlockStack gap="200">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                Edit location
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Changes sync to your Shopify store.
              </Text>
            </BlockStack>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="update" />
              <input type="hidden" name="name" value={name} />
              <input type="hidden" name="address1" value={address1} />
              <input type="hidden" name="address2" value={address2} />
              <input type="hidden" name="city" value={city} />
              <input type="hidden" name="provinceCode" value={provinceCode} />
              <input type="hidden" name="zip" value={zip} />
              <input type="hidden" name="countryCode" value={countryCode} />
              <FormLayout>
                <TextField
                  label="Name"
                  value={name}
                  onChange={setName}
                  autoComplete="off"
                  requiredIndicator
                />
                <AddressForm
                  countryCode={countryCode}
                  onCountryChange={setCountryCode}
                  address1={address1}
                  onAddress1Change={setAddress1}
                  address2={address2}
                  onAddress2Change={setAddress2}
                  city={city}
                  onCityChange={setCity}
                  provinceCode={provinceCode}
                  onProvinceCodeChange={setProvinceCode}
                  zip={zip}
                  onZipChange={setZip}
                  columns={2}
                />
                <Button variant="primary" submit loading={fetcher.state !== "idle"}>
                  Save changes
                </Button>
              </FormLayout>
            </fetcher.Form>
          </BlockStack>
        </Card>
        </div>

        {location.isActive && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Deactivate
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Deactivating moves inventory to another location. You must deactivate before deleting.
              </Text>
              <Button tone="critical" onClick={() => setDeactivateModalOpen(true)}>
                Deactivate location
              </Button>
            </BlockStack>
          </Card>
        )}

        {!location.isActive && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Delete
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Permanently remove this location from your Shopify store. This cannot be undone.
              </Text>
              <Button tone="critical" destructive onClick={() => setDeleteModalOpen(true)}>
                Delete location
              </Button>
            </BlockStack>
          </Card>
        )}

        {deactivateModalOpen && (
          <Modal
            open={deactivateModalOpen}
            onClose={() => setDeactivateModalOpen(false)}
            title="Deactivate location"
            primaryAction={{
              content: "Deactivate",
              destructive: true,
              onAction: () => {
                const formData = new FormData();
                formData.set("intent", "deactivate");
                formData.set("destinationLocationId", destinationLocationId);
                fetcher.submit(formData, { method: "post" });
                setDeactivateModalOpen(false);
              },
              loading: fetcher.state !== "idle",
              disabled: !destinationLocationId || otherLocations.length === 0,
            }}
            secondaryActions={[{ content: "Cancel", onAction: () => setDeactivateModalOpen(false) }]}
          >
            <Modal.Section>
              <BlockStack gap="300">
                <Text as="p" variant="bodyMd">
                  Inventory at {location.name} will be moved to the destination. Select where to move it:
                </Text>
                {otherLocations.length === 0 ? (
                  <Banner tone="warning">
                    You need at least one other active location to deactivate this one. Create another location first.
                  </Banner>
                ) : (
                  <Select
                    label="Destination location"
                    options={[{ label: "Select location", value: "" }, ...destinationOptions]}
                    value={destinationLocationId}
                    onChange={setDestinationLocationId}
                  />
                )}
              </BlockStack>
            </Modal.Section>
          </Modal>
        )}

        {deleteModalOpen && (
          <Modal
            open={deleteModalOpen}
            onClose={() => setDeleteModalOpen(false)}
            title="Delete location"
            primaryAction={{
              content: "Delete",
              destructive: true,
              onAction: () => {
                const formData = new FormData();
                formData.set("intent", "delete");
                fetcher.submit(formData, { method: "post" });
                setDeleteModalOpen(false);
              },
              loading: fetcher.state !== "idle",
            }}
            secondaryActions={[{ content: "Cancel", onAction: () => setDeleteModalOpen(false) }]}
          >
            <Modal.Section>
              <Text as="p" variant="bodyMd">
                Permanently delete {location.name}? This cannot be undone.
              </Text>
            </Modal.Section>
          </Modal>
        )}
      </BlockStack>
    </PageShell>
  );
}
