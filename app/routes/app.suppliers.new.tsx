import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useNavigate } from "@remix-run/react";
import { useState, useEffect } from "react";
import { Card, FormLayout, TextField, Button, BlockStack, Banner } from "@shopify/polaris";
import { PageShell } from "../components/PageShell";
import { AddressForm } from "../components/AddressForm";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { success: false, error: "Shop not found" };

  const formData = await request.formData();
  const name = String(formData.get("name") || "").trim();
  if (!name) return { success: false, error: "Name required" };

  const countryCode = String(formData.get("countryCode") || "US").trim() || "US";
  const address1 = String(formData.get("address1") || "").trim() || null;
  const address2 = String(formData.get("address2") || "").trim() || null;
  const city = String(formData.get("city") || "").trim() || null;
  const provinceCode = String(formData.get("provinceCode") || "").trim() || null;
  const zip = String(formData.get("zip") || "").trim() || null;

  const supplier = await prisma.supplier.create({
    data: {
      shopId: shop.id,
      name,
      email: String(formData.get("email") || "").trim() || null,
      phone: String(formData.get("phone") || "").trim() || null,
      address1,
      address2,
      city,
      provinceCode,
      zip,
      countryCode,
    },
  });
  return { success: true };
};

export default function NewSupplier() {
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [provinceCode, setProvinceCode] = useState("");
  const [zip, setZip] = useState("");
  const [countryCode, setCountryCode] = useState("US");

  useEffect(() => {
    if (fetcher.data?.success) {
      navigate("/app/suppliers");
    }
  }, [fetcher.data, navigate]);

  const error = fetcher.data && !fetcher.data.success ? fetcher.data.error : null;

  return (
    <PageShell title="Add supplier" backAction={{ url: "/app/suppliers" }}>
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" onDismiss={() => {}}>
            {error}
          </Banner>
        )}
        <Card>
          <fetcher.Form method="post">
            <FormLayout>
              <input type="hidden" name="name" value={name} />
              <input type="hidden" name="email" value={email} />
              <input type="hidden" name="phone" value={phone} />
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
              />
              <TextField
                label="Email"
                type="email"
                value={email}
                onChange={setEmail}
                autoComplete="off"
              />
              <TextField
                label="Phone"
                value={phone}
                onChange={setPhone}
                autoComplete="off"
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
                Save
              </Button>
            </FormLayout>
          </fetcher.Form>
        </Card>
      </BlockStack>
    </PageShell>
  );
}
