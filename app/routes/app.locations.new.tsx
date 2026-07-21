import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useNavigate } from "@remix-run/react";
import { useState, useEffect } from "react";
import { Card, FormLayout, TextField, Button, BlockStack, Banner, Text } from "@shopify/polaris";
import { PageShell } from "../components/PageShell";
import { AddressForm } from "../components/AddressForm";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createLocation } from "../services/location.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return json({ success: false, error: "Shop not found" }, { status: 404 });

  const formData = await request.formData();
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
  if (city) address.city = city;
  if (provinceCode) address.provinceCode = provinceCode;
  if (zip) address.zip = zip;

  const result = await createLocation(
    admin as Parameters<typeof createLocation>[0],
    shop.id,
    { name, address }
  );

  if (!result.success) {
    return json({ success: false, error: result.error }, { status: 400 });
  }

  return json({ success: true, redirect: "/app/locations" });
};

export default function NewLocation() {
  const fetcher = useFetcher<{ success?: boolean; error?: string; redirect?: string }>();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [provinceCode, setProvinceCode] = useState("");
  const [zip, setZip] = useState("");
  const [countryCode, setCountryCode] = useState("US");

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.redirect && fetcher.state === "idle") {
      navigate(fetcher.data.redirect);
    }
  }, [fetcher.data, fetcher.state, navigate]);

  const error = fetcher.data && !fetcher.data.success ? fetcher.data.error : null;

  return (
    <PageShell title="Add location" backAction={{ url: "/app/locations" }}>
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" onDismiss={() => {}}>
            {error}
          </Banner>
        )}
        <Card>
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd" tone="subdued">
              Creates a new location in your Shopify store. Name and country are required.
            </Text>
            <fetcher.Form method="post">
              <FormLayout>
                <input type="hidden" name="name" value={name} />
                <input type="hidden" name="address1" value={address1} />
                <input type="hidden" name="address2" value={address2} />
                <input type="hidden" name="city" value={city} />
                <input type="hidden" name="provinceCode" value={provinceCode} />
                <input type="hidden" name="zip" value={zip} />
                <input type="hidden" name="countryCode" value={countryCode} />
                <TextField
                  label="Name"
                  value={name}
                  onChange={setName}
                  autoComplete="off"
                  requiredIndicator
                  helpText="e.g. Main Warehouse, Downtown Store"
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
                  Create location
                </Button>
              </FormLayout>
            </fetcher.Form>
          </BlockStack>
        </Card>
      </BlockStack>
    </PageShell>
  );
}
