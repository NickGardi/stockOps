import { useState, useCallback, useEffect } from "react";
import { useFetcher, useRevalidator } from "@remix-run/react";
import {
  Modal,
  BlockStack,
  InlineStack,
  Button,
  TextField,
  Checkbox,
  Box,
  Text,
  Banner,
  DataTable,
} from "@shopify/polaris";

export type VariantForAdd = {
  id: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  onHand: number;
  onOrder: number;
  unitCost: string | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  variants: VariantForAdd[];
  actionUrl: string;
};

export function AddProductsModal({ open, onClose, onSuccess, variants, actionUrl }: Props) {
  const addFetcher = useFetcher<{ redirect?: string; error?: string }>();
  const revalidator = useRevalidator();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [defaultQty, setDefaultQty] = useState("1");
  const [search, setSearch] = useState("");

  const filteredVariants = search.trim()
    ? variants.filter((v) => {
        const s = search.toLowerCase();
        return (
          v.productTitle.toLowerCase().includes(s) ||
          v.variantTitle.toLowerCase().includes(s) ||
          (v.sku?.toLowerCase().includes(s) ?? false)
        );
      })
    : variants;

  useEffect(() => {
    const data = addFetcher.data as { redirect?: string } | undefined;
    if (data?.redirect && addFetcher.state === "idle") {
      setSelectedIds(new Set());
      setQuantities({});
      setSearch("");
      onSuccess?.();
      onClose();
      revalidator.revalidate();
    }
  }, [addFetcher.data, addFetcher.state, onSuccess, onClose, revalidator]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === filteredVariants.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredVariants.map((v) => v.id)));
    }
  }, [selectedIds.size, filteredVariants]);

  const setQuantity = useCallback((id: string, value: string) => {
    setQuantities((prev) => ({ ...prev, [id]: value }));
  }, []);

  const getQuantity = (id: string) => {
    const q = quantities[id];
    if (q !== undefined && q !== "") return parseInt(q, 10);
    return parseInt(defaultQty, 10) || 1;
  };

  const handleAdd = useCallback(() => {
    if (selectedIds.size === 0) return;
    const payload = [...selectedIds].map((variantId) => ({
      variantId,
      quantity: Math.max(1, getQuantity(variantId)),
    }));
    const formData = new FormData();
    formData.set("intent", "bulkAddLines");
    formData.set("payload", JSON.stringify(payload));
    addFetcher.submit(formData, { method: "post", action: actionUrl });
  }, [selectedIds, quantities, defaultQty, actionUrl]);

  const handleClose = useCallback(() => {
    setSelectedIds(new Set());
    setQuantities({});
    setDefaultQty("1");
    setSearch("");
    onClose();
  }, [onClose]);

  const canAdd = selectedIds.size > 0;
  const allValidQty = [...selectedIds].every((id) => getQuantity(id) >= 1);

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Add products to purchase order"
      size="large"
      primaryAction={{
        content: `Add ${selectedIds.size} selected`,
        onAction: handleAdd,
        disabled: !canAdd || !allValidQty || addFetcher.state !== "idle",
        loading: addFetcher.state !== "idle",
      }}
      secondaryActions={[{ content: "Cancel", onAction: handleClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {addFetcher.data && "error" in addFetcher.data && addFetcher.data.error && (
            <Banner tone="critical" onDismiss={() => {}}>
              {addFetcher.data.error}
            </Banner>
          )}
          <InlineStack gap="300" wrap blockAlign="end">
            <Box minWidth="200px">
              <TextField
                label="Search"
                labelHidden
                value={search}
                onChange={setSearch}
                placeholder="Product, variant, SKU..."
                autoComplete="off"
              />
            </Box>
            <Box minWidth="120px">
              <TextField
                label="Default quantity"
                type="number"
                value={defaultQty}
                onChange={setDefaultQty}
                min={1}
                autoComplete="off"
              />
            </Box>
            <InlineStack gap="200" blockAlign="center">
              <Checkbox
                label="Select all"
                checked={filteredVariants.length > 0 && selectedIds.size === filteredVariants.length}
                onChange={toggleSelectAll}
              />
              <Text as="p" variant="bodyMd" tone="subdued">
                {selectedIds.size} of {filteredVariants.length} selected
              </Text>
            </InlineStack>
          </InlineStack>
          <div style={{ maxHeight: "400px", overflowY: "auto" }}>
            {filteredVariants.length === 0 ? (
              <Box padding="400">
                <Text as="p" variant="bodyMd" tone="subdued">
                  {variants.length === 0
                  ? "No products available from this supplier. Assign products to the supplier first."
                  : "No products match your search."}
                </Text>
              </Box>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "numeric", "numeric", "text", "numeric"]}
                headings={["", "Product", "Variant", "SKU", "Stock", "On Order", "Cost", "Quantity"]}
                rows={filteredVariants.map((v) => [
                  <Checkbox
                    key={v.id}
                    label=""
                    labelHidden
                    checked={selectedIds.has(v.id)}
                    onChange={() => toggleSelect(v.id)}
                  />,
                  v.productTitle,
                  v.variantTitle,
                  v.sku || "—",
                  v.onHand,
                  v.onOrder,
                  v.unitCost || "—",
                  selectedIds.has(v.id) ? (
                    <TextField
                      key={v.id}
                      label=""
                      labelHidden
                      type="number"
                      value={quantities[v.id] ?? defaultQty}
                      onChange={(val) => setQuantity(v.id, val)}
                      min={1}
                      autoComplete="off"
                    />
                  ) : (
                    "—"
                  ),
                ])}
              />
            )}
          </div>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
