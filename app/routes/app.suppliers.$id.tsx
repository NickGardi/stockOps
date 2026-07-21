import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, redirect } from "@remix-run/react";
import React, { useState, useEffect, useRef } from "react";
import {
  Card,
  FormLayout,
  TextField,
  Button,
  BlockStack,
  Text,
  Banner,
  DataTable,
  Modal,
  InlineStack,
  Checkbox,
  Box,
  Tooltip,
  Select,
} from "@shopify/polaris";
import { PageShell } from "../components/PageShell";
import {
  getCountryOptions,
  getAddressLabels,
  getProvinceOptions,
} from "../lib/address";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ChevronLeftIcon, DeleteIcon } from "@shopify/polaris-icons";
import { BulkAssignModal } from "../components/BulkAssignModal";
import "../styles/supplier-detail-table.css";
import "../styles/bulk-assign-modal.css";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const supplier = await prisma.supplier.findFirst({
    where: { id: params.id!, shopId: shop.id },
    include: {
      variantSuppliers: {
        include: {
          variant: { include: { product: true } },
        },
      },
    },
  });
  if (!supplier) throw new Response("Not found", { status: 404 });

  return {
    supplier,
    suppliedVariants: supplier.variantSuppliers.map((vs) => ({
      id: vs.id,
      variantId: vs.variant.id,
      productTitle: vs.variant.product.title,
      variantTitle: vs.variant.title,
      sku: vs.variant.sku,
      cost: vs.cost,
      leadTimeDays: vs.leadTimeDays,
      minStock: vs.minStock,
      maxStock: vs.maxStock,
      minOrderQty: vs.minOrderQty,
    })),
  };
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
  const intent = formData.get("intent");

  if (intent === "delete") {
    await prisma.supplier.delete({ where: { id: supplier.id } });
    return redirect("/app/suppliers");
  }

  if (intent === "removeVariant") {
    const variantSupplierId = String(formData.get("variantSupplierId") || "");
    const vs = await prisma.variantSupplier.findFirst({
      where: { id: variantSupplierId, supplierId: supplier.id },
    });
    if (vs) await prisma.variantSupplier.delete({ where: { id: vs.id } });
    return redirect(`/app/suppliers/${supplier.id}`);
  }

  if (intent === "bulkUpdateSuppliedVariants") {
    const updatesRaw = String(formData.get("updates") || "[]");
    let updates: Array<{ id: string; cost: string; leadTimeDays: string; minStock: string; maxStock: string; minOrderQty: string }>;
    try {
      updates = JSON.parse(updatesRaw);
    } catch {
      return json({ success: false, error: "Invalid updates" }, { status: 400 });
    }
    for (const u of updates) {
      const vs = await prisma.variantSupplier.findFirst({
        where: { id: u.id, supplierId: supplier.id },
      });
      if (!vs) continue;
      const cost = u.cost.trim() || null;
      const leadTimeDaysParsed = parseInt(u.leadTimeDays, 10);
      const leadTimeDays = !Number.isNaN(leadTimeDaysParsed) && leadTimeDaysParsed >= 0 ? leadTimeDaysParsed : null;
      const minStockParsed = u.minStock.trim() ? parseInt(u.minStock, 10) : null;
      const minStock = minStockParsed != null && !Number.isNaN(minStockParsed) && minStockParsed >= 0 ? minStockParsed : null;
      const maxStockParsed = u.maxStock.trim() ? parseInt(u.maxStock, 10) : null;
      const maxStock = maxStockParsed != null && !Number.isNaN(maxStockParsed) && maxStockParsed >= 0 ? maxStockParsed : null;
      const minOrderQtyParsed = u.minOrderQty.trim() ? parseInt(u.minOrderQty, 10) : null;
      const minOrderQty = minOrderQtyParsed != null && !Number.isNaN(minOrderQtyParsed) && minOrderQtyParsed >= 0 ? minOrderQtyParsed : null;
      await prisma.variantSupplier.update({
        where: { id: vs.id },
        data: {
          cost,
          leadTimeDays,
          minStock,
          maxStock,
          minOrderQty,
        },
      });
    }
    return json({ success: true });
  }

  if (intent === "updateVariantSupplier") {
    const variantSupplierId = String(formData.get("variantSupplierId") || "");
    const cost = String(formData.get("cost") || "").trim() || null;
    const leadTimeDays = parseInt(String(formData.get("leadTimeDays") ?? "0"), 10);
    const minStockRaw = String(formData.get("minStock") || "").trim();
    const maxStockRaw = String(formData.get("maxStock") || "").trim();
    const minOrderQtyRaw = String(formData.get("minOrderQty") || "").trim();
    const minStock = minStockRaw ? parseInt(minStockRaw, 10) : null;
    const maxStock = maxStockRaw ? parseInt(maxStockRaw, 10) : null;
    const minOrderQty = minOrderQtyRaw ? parseInt(minOrderQtyRaw, 10) : null;

    const vs = await prisma.variantSupplier.findFirst({
      where: { id: variantSupplierId, supplierId: supplier.id },
    });
    if (vs) {
      await prisma.variantSupplier.update({
        where: { id: vs.id },
        data: {
          cost,
          leadTimeDays: leadTimeDays >= 0 ? leadTimeDays : vs.leadTimeDays,
          minStock: minStock != null && !Number.isNaN(minStock) && minStock >= 0 ? minStock : null,
          maxStock: maxStock != null && !Number.isNaN(maxStock) && maxStock >= 0 ? maxStock : null,
          minOrderQty: minOrderQty != null && !Number.isNaN(minOrderQty) && minOrderQty >= 0 ? minOrderQty : null,
        },
      });
    }
    return json({ success: true });
  }

  const name = String(formData.get("name") || "").trim();
  if (!name) return { success: false, error: "Name required" };

  const defaultLeadTimeRaw = String(formData.get("defaultLeadTimeDays") || "").trim();
  const defaultLeadTimeDays = defaultLeadTimeRaw ? parseInt(defaultLeadTimeRaw, 10) : null;
  const defaultCostRaw = String(formData.get("defaultCost") || "").trim();
  const defaultCost = defaultCostRaw && !Number.isNaN(parseFloat(defaultCostRaw)) && parseFloat(defaultCostRaw) >= 0 ? defaultCostRaw : null;
  const defaultMinStockRaw = String(formData.get("defaultMinStock") || "").trim();
  const defaultMinStock = defaultMinStockRaw ? parseInt(defaultMinStockRaw, 10) : null;
  const defaultMaxStockRaw = String(formData.get("defaultMaxStock") || "").trim();
  const defaultMaxStock = defaultMaxStockRaw ? parseInt(defaultMaxStockRaw, 10) : null;
  const defaultMinOrderQtyRaw = String(formData.get("defaultMinOrderQty") || "").trim();
  const defaultMinOrderQty = defaultMinOrderQtyRaw ? parseInt(defaultMinOrderQtyRaw, 10) : null;
  const notes = String(formData.get("notes") || "").trim() || null;

  await prisma.supplier.update({
    where: { id: supplier.id },
    data: {
      name,
      email: String(formData.get("email") || "").trim() || null,
      phone: String(formData.get("phone") || "").trim() || null,
      address1: String(formData.get("address1") || "").trim() || null,
      address2: String(formData.get("address2") || "").trim() || null,
      city: String(formData.get("city") || "").trim() || null,
      provinceCode: String(formData.get("provinceCode") || "").trim() || null,
      zip: String(formData.get("zip") || "").trim() || null,
      countryCode: String(formData.get("countryCode") || "US").trim() || "US",
      notes,
      defaultLeadTimeDays: defaultLeadTimeDays != null && !Number.isNaN(defaultLeadTimeDays) && defaultLeadTimeDays >= 0 ? defaultLeadTimeDays : null,
      defaultCost,
      defaultMinStock: defaultMinStock != null && !Number.isNaN(defaultMinStock) && defaultMinStock >= 0 ? defaultMinStock : null,
      defaultMaxStock: defaultMaxStock != null && !Number.isNaN(defaultMaxStock) && defaultMaxStock >= 0 ? defaultMaxStock : null,
      defaultMinOrderQty: defaultMinOrderQty != null && !Number.isNaN(defaultMinOrderQty) && defaultMinOrderQty >= 0 ? defaultMinOrderQty : null,
    },
  });
  return { success: true };
};

export default function SupplierDetail() {
  const { supplier, suppliedVariants } = useLoaderData<typeof loader>();
  const saveFetcher = useFetcher<typeof action>();
  const suppliedSaveFetcher = useFetcher<typeof action>();
  const deleteFetcher = useFetcher();
  const removeFetcher = useFetcher();
  const navigate = useNavigate();
  const [name, setName] = useState(supplier.name || "");
  const [email, setEmail] = useState(supplier.email || "");
  const [phone, setPhone] = useState(supplier.phone || "");
  const [address1, setAddress1] = useState(supplier.address1 || "");
  const [address2, setAddress2] = useState(supplier.address2 || "");
  const [city, setCity] = useState(supplier.city || "");
  const [provinceCode, setProvinceCode] = useState(supplier.provinceCode || "");
  const [zip, setZip] = useState(supplier.zip || "");
  const [countryCode, setCountryCode] = useState(supplier.countryCode || "US");
  const [notes, setNotes] = useState(supplier.notes || "");
  const [defaultLeadTimeDays, setDefaultLeadTimeDays] = useState(String(supplier.defaultLeadTimeDays ?? ""));
  const [defaultCost, setDefaultCost] = useState(supplier.defaultCost ?? "");
  const [defaultMinStock, setDefaultMinStock] = useState(String(supplier.defaultMinStock ?? ""));
  const [defaultMaxStock, setDefaultMaxStock] = useState(String(supplier.defaultMaxStock ?? ""));
  const [defaultMinOrderQty, setDefaultMinOrderQty] = useState(String(supplier.defaultMinOrderQty ?? ""));
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [removeModal, setRemoveModal] = useState<{ id: string; label: string } | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const suppliedFormRef = useRef<HTMLFormElement>(null);
  const debouncedSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (debouncedSaveRef.current) clearTimeout(debouncedSaveRef.current);
    };
  }, []);

  useEffect(() => {
    setName(supplier.name || "");
    setEmail(supplier.email || "");
    setPhone(supplier.phone || "");
    setAddress1(supplier.address1 || "");
    setAddress2(supplier.address2 || "");
    setCity(supplier.city || "");
    setProvinceCode(supplier.provinceCode || "");
    setZip(supplier.zip || "");
    setCountryCode(supplier.countryCode || "US");
    setNotes(supplier.notes || "");
    setDefaultLeadTimeDays(String(supplier.defaultLeadTimeDays ?? ""));
    setDefaultCost(supplier.defaultCost ?? "");
    setDefaultMinStock(String(supplier.defaultMinStock ?? ""));
    setDefaultMaxStock(String(supplier.defaultMaxStock ?? ""));
    setDefaultMinOrderQty(String(supplier.defaultMinOrderQty ?? ""));
  }, [supplier.id]);

  const saveError = saveFetcher.data && !saveFetcher.data.success ? saveFetcher.data.error : null;
  const suppliedSaveError =
    suppliedSaveFetcher.data && !suppliedSaveFetcher.data.success ? suppliedSaveFetcher.data.error : null;

  const scheduleSuppliedSave = () => {
    if (debouncedSaveRef.current) clearTimeout(debouncedSaveRef.current);
      debouncedSaveRef.current = setTimeout(() => {
      const form = suppliedFormRef.current;
      if (!form) return;
      const updates = suppliedVariants.map((v) => ({
        id: v.id,
        cost: String(form.querySelector<HTMLInputElement>(`[name="cost-${v.id}"]`)?.value ?? "").trim(),
        leadTimeDays: String(form.querySelector<HTMLInputElement>(`[name="leadTime-${v.id}"]`)?.value ?? "").trim(),
        minStock: String(form.querySelector<HTMLInputElement>(`[name="minStock-${v.id}"]`)?.value ?? "").trim(),
        maxStock: String(form.querySelector<HTMLInputElement>(`[name="maxStock-${v.id}"]`)?.value ?? "").trim(),
        minOrderQty: String(form.querySelector<HTMLInputElement>(`[name="minOrderQty-${v.id}"]`)?.value ?? "").trim(),
      }));
      const formData = new FormData();
      formData.set("intent", "bulkUpdateSuppliedVariants");
      formData.set("updates", JSON.stringify(updates));
      suppliedSaveFetcher.submit(formData, { method: "post", action: `/app/suppliers/${supplier.id}` });
      debouncedSaveRef.current = null;
    }, 1200);
  };

  const suppliedPanel = (
    <BlockStack gap="400">
      {suppliedVariants.length === 0 ? (
        <Text as="p" variant="bodyMd" tone="subdued">
          No variants assigned.
        </Text>
      ) : (
        <Box position="relative">
          {suppliedSaveError && (
            <Banner tone="critical" onDismiss={() => {}}>
              {suppliedSaveError}
            </Banner>
          )}
          <form
            ref={suppliedFormRef}
            onSubmit={(e) => e.preventDefault()}
            className="supplier-supplied-table"
          >
            <table>
              <thead>
                <tr>
                  <th><strong>Product</strong></th>
                  <th><strong>Variant</strong></th>
                  <th><strong>SKU</strong></th>
                  <th><strong>Unit Cost</strong></th>
                  <th>
                    <InlineStack gap="100" blockAlign="center">
                      <strong>Lead Time</strong>
                      <Tooltip content="Days until stock arrives after placing an order. Used for reorder suggestions.">
                        <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                      </Tooltip>
                    </InlineStack>
                  </th>
                  <th>
                    <InlineStack gap="100" blockAlign="center">
                      <strong>Min</strong>
                      <Tooltip content="Reorder point. When stock falls below this level, the system suggests reordering. For most items, set to at least (daily sales × lead time).">
                        <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                      </Tooltip>
                    </InlineStack>
                  </th>
                  <th>
                    <InlineStack gap="100" blockAlign="center">
                      <strong>Max</strong>
                      <Tooltip content="Maximum stock you want to hold. Suggested orders are based on sales velocity and will not exceed this ceiling.">
                        <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                      </Tooltip>
                    </InlineStack>
                  </th>
                  <th>
                    <InlineStack gap="100" blockAlign="center">
                      <strong>Min Order</strong>
                      <Tooltip content="Minimum units required per order from this supplier.">
                        <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                      </Tooltip>
                    </InlineStack>
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {suppliedVariants.map((v, idx) => (
                  <tr key={v.id} className={idx % 2 === 1 ? "supplier-table-row-alt" : ""}>
                    <td>{v.productTitle}</td>
                    <td>{v.variantTitle}</td>
                    <td style={{ textAlign: "center" }}>{v.sku || "—"}</td>
                    <td>
                      <input
                        type="text"
                        name={`cost-${v.id}`}
                        defaultValue={v.cost ?? ""}
                        onChange={() => scheduleSuppliedSave()}
                        autoComplete="off"
                        placeholder="0"
                        aria-label="Unit cost"
                        className="supplier-numeric-input"
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        name={`leadTime-${v.id}`}
                        defaultValue={String(v.leadTimeDays ?? "")}
                        onChange={() => scheduleSuppliedSave()}
                        autoComplete="off"
                        placeholder="0"
                        aria-label="Lead time"
                        className="supplier-numeric-input"
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        name={`minStock-${v.id}`}
                        defaultValue={v.minStock != null ? String(v.minStock) : ""}
                        onChange={() => scheduleSuppliedSave()}
                        autoComplete="off"
                        placeholder="—"
                        aria-label="Min stock"
                        className="supplier-numeric-input"
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        name={`maxStock-${v.id}`}
                        defaultValue={v.maxStock != null ? String(v.maxStock) : ""}
                        onChange={() => scheduleSuppliedSave()}
                        autoComplete="off"
                        placeholder="—"
                        aria-label="Max stock"
                        className="supplier-numeric-input"
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        name={`minOrderQty-${v.id}`}
                        defaultValue={v.minOrderQty != null ? String(v.minOrderQty) : ""}
                        onChange={() => scheduleSuppliedSave()}
                        autoComplete="off"
                        placeholder="—"
                        aria-label="Min order quantity"
                        className="supplier-numeric-input"
                      />
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Button
                        icon={DeleteIcon}
                        size="slim"
                        tone="critical"
                        variant="plain"
                        type="button"
                        accessibilityLabel="Remove"
                        onClick={() => setRemoveModal({ id: v.id, label: `${v.productTitle} - ${v.variantTitle}` })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </form>
        </Box>
      )}
    </BlockStack>
  );

  return (
    <PageShell title={supplier.name} backAction={{ url: "/app/suppliers" }}>
      <BlockStack gap="400">
        <InlineStack align="start" blockAlign="start">
          <Button icon={ChevronLeftIcon} variant="plain" size="slim" onClick={() => navigate("/app/suppliers")}>
            Back to suppliers
          </Button>
        </InlineStack>
        {saveError && (
          <Banner tone="critical" onDismiss={() => {}}>
            {saveError}
          </Banner>
        )}
        <div style={{ width: "100%" }}>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center" gap="400">
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  Assigned variants ({suppliedVariants.length})
                </Text>
                <Button variant="primary" onClick={() => setAssignModalOpen(true)}>
                  Assign variants to this supplier
                </Button>
              </InlineStack>
              {suppliedPanel}
            </BlockStack>
          </Card>
          <Box paddingBlockStart="400">
            <Card>
              <saveFetcher.Form method="post">
                  <input type="hidden" name="name" value={name} />
                  <input type="hidden" name="email" value={email} />
                  <input type="hidden" name="phone" value={phone} />
                  <input type="hidden" name="address1" value={address1} />
                  <input type="hidden" name="address2" value={address2} />
                  <input type="hidden" name="city" value={city} />
                  <input type="hidden" name="provinceCode" value={provinceCode} />
                  <input type="hidden" name="zip" value={zip} />
                  <input type="hidden" name="countryCode" value={countryCode} />
                  <input type="hidden" name="notes" value={notes} />
                  <input type="hidden" name="defaultLeadTimeDays" value={defaultLeadTimeDays} />
                  <input type="hidden" name="defaultCost" value={defaultCost} />
                  <input type="hidden" name="defaultMinStock" value={defaultMinStock} />
                  <input type="hidden" name="defaultMaxStock" value={defaultMaxStock} />
                  <input type="hidden" name="defaultMinOrderQty" value={defaultMinOrderQty} />
                  <BlockStack gap="400">
                    <BlockStack gap="200">
                      <Text as="h2" variant="headingMd">
                        Supplier details
                      </Text>
                      <div className="supplier-details-grid">
                        <div>
                          <TextField
                            label="Name"
                            value={name}
                            onChange={setName}
                            autoComplete="off"
                          />
                        </div>
                        <div>
                          <TextField
                            label="Email"
                            type="email"
                            value={email}
                            onChange={setEmail}
                            autoComplete="off"
                          />
                        </div>
                        <div>
                          <Select
                            label="Country"
                            options={getCountryOptions()}
                            value={countryCode}
                            onChange={setCountryCode}
                          />
                        </div>
                        <div>
                          <TextField
                            label="Phone"
                            value={phone}
                            onChange={setPhone}
                            autoComplete="off"
                          />
                        </div>
                        <div>
                          <TextField
                            label={getAddressLabels(countryCode).address1}
                            value={address1}
                            onChange={setAddress1}
                            autoComplete="street-address"
                          />
                        </div>
                        <div>
                          <TextField
                            label="Address line 2"
                            value={address2}
                            onChange={setAddress2}
                            autoComplete="address-line2"
                          />
                        </div>
                        <div>
                          <TextField
                            label={getAddressLabels(countryCode).city}
                            value={city}
                            onChange={setCity}
                            autoComplete="address-level2"
                          />
                        </div>
                        <div>
                          {getProvinceOptions(countryCode).length > 0 ? (
                            <Select
                              label={getAddressLabels(countryCode).province}
                              options={[{ label: "Select", value: "" }, ...getProvinceOptions(countryCode)]}
                              value={provinceCode || ""}
                              onChange={setProvinceCode}
                            />
                          ) : (
                            <TextField
                              label={getAddressLabels(countryCode).province}
                              value={provinceCode}
                              onChange={setProvinceCode}
                              autoComplete="address-level1"
                            />
                          )}
                        </div>
                        <div>
                          <TextField
                            label={getAddressLabels(countryCode).zip}
                            value={zip}
                            onChange={setZip}
                            autoComplete="postal-code"
                          />
                        </div>
                        <div>
                          <TextField
                            label="Notes"
                            value={notes}
                            onChange={setNotes}
                            autoComplete="off"
                          />
                        </div>
                      </div>
                    </BlockStack>
                    <Box borderBlockStartWidth="025" borderColor="border" paddingBlockStart="400">
                      <BlockStack gap="200">
                        <Text as="h3" variant="headingSm">
                          Default values
                        </Text>
                        <Text as="p" variant="bodyMd" tone="subdued">
                          Used when assigning new variants to this supplier. Leave blank to set per variant.
                        </Text>
                        <div className="supplier-details-grid">
                          <div>
                            <TextField
                              label={
                                <InlineStack gap="100" blockAlign="center">
                                  <span>Default lead time (days)</span>
                                  <Tooltip content="Pre-fills lead time when assigning new variants to this supplier. Override per variant as needed.">
                                    <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                                  </Tooltip>
                                </InlineStack>
                              }
                              type="number"
                              min={0}
                              value={defaultLeadTimeDays}
                              onChange={setDefaultLeadTimeDays}
                              autoComplete="off"
                            />
                          </div>
                          <div>
                            <TextField
                              label={
                                <InlineStack gap="100" blockAlign="center">
                                  <span>Default cost</span>
                                  <Tooltip content="Pre-fills unit cost when assigning new variants. Override per variant as needed.">
                                    <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                                  </Tooltip>
                                </InlineStack>
                              }
                              type="text"
                              value={defaultCost}
                              onChange={setDefaultCost}
                              autoComplete="off"
                            />
                          </div>
                          <div>
                            <TextField
                              label={
                                <InlineStack gap="100" blockAlign="center">
                                  <span>Default min stock</span>
                                  <Tooltip content="Pre-fills min stock when assigning new variants. Override per variant as needed.">
                                    <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                                  </Tooltip>
                                </InlineStack>
                              }
                              type="number"
                              min={0}
                              value={defaultMinStock}
                              onChange={setDefaultMinStock}
                              autoComplete="off"
                            />
                          </div>
                          <div>
                            <TextField
                              label={
                                <InlineStack gap="100" blockAlign="center">
                                  <span>Default max stock</span>
                                  <Tooltip content="Pre-fills max stock when assigning new variants. Override per variant as needed.">
                                    <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                                  </Tooltip>
                                </InlineStack>
                              }
                              type="number"
                              min={0}
                              value={defaultMaxStock}
                              onChange={setDefaultMaxStock}
                              autoComplete="off"
                            />
                          </div>
                          <div>
                            <TextField
                              label={
                                <InlineStack gap="100" blockAlign="center">
                                  <span>Default min order quantity</span>
                                  <Tooltip content="Pre-fills min order quantity when assigning new variants. Override per variant as needed.">
                                    <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                                  </Tooltip>
                                </InlineStack>
                              }
                              type="number"
                              min={0}
                              value={defaultMinOrderQty}
                              onChange={setDefaultMinOrderQty}
                              autoComplete="off"
                            />
                          </div>
                        </div>
                      </BlockStack>
                    </Box>
                  </BlockStack>
                  <Box paddingBlockStart="400">
                    <InlineStack gap="200">
                      <Button variant="primary" submit loading={saveFetcher.state !== "idle"}>
                        Save
                      </Button>
                      <Button variant="primary" tone="critical" onClick={() => setDeleteModalOpen(true)}>
                        Delete supplier
                      </Button>
                    </InlineStack>
                  </Box>
                </saveFetcher.Form>
            </Card>
          </Box>
        </div>
        <BulkAssignModal
          open={assignModalOpen}
          onClose={() => setAssignModalOpen(false)}
          onSuccess={() => navigate(0)}
          preSelectedSupplierId={supplier.id}
        />
        {deleteModalOpen && (
          <Modal
            open={deleteModalOpen}
            onClose={() => setDeleteModalOpen(false)}
            title="Delete supplier"
            primaryAction={{
              content: "Delete",
              destructive: true,
              loading: deleteFetcher.state !== "idle",
              onAction: () => {
                const formData = new FormData();
                formData.set("intent", "delete");
                deleteFetcher.submit(formData, { method: "post", action: `/app/suppliers/${supplier.id}` });
                setDeleteModalOpen(false);
              },
            }}
            secondaryActions={[{ content: "Cancel", onAction: () => setDeleteModalOpen(false) }]}
          >
            <Modal.Section>
              <Text as="p">Are you sure you want to delete {supplier.name}? This cannot be undone.</Text>
            </Modal.Section>
          </Modal>
        )}
        {removeModal && (
          <Modal
            open={!!removeModal}
            onClose={() => setRemoveModal(null)}
            title="Remove variant"
            primaryAction={{
              content: "Remove",
              destructive: true,
              onAction: () => {
                const formData = new FormData();
                formData.set("intent", "removeVariant");
                formData.set("variantSupplierId", removeModal.id);
                removeFetcher.submit(formData, { method: "post", action: `/app/suppliers/${supplier.id}` });
                setRemoveModal(null);
              },
            }}
            secondaryActions={[{ content: "Cancel", onAction: () => setRemoveModal(null) }]}
          >
            <Modal.Section>
              <Text as="p">Remove {removeModal.label} from this supplier?</Text>
            </Modal.Section>
          </Modal>
        )}
      </BlockStack>
    </PageShell>
  );
}
