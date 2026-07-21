import { useState, useEffect } from "react";
import { useFetcher } from "@remix-run/react";
import { Modal, BlockStack, TextField, Banner, InlineStack, Tooltip } from "@shopify/polaris";

type Props = {
  open: boolean;
  onClose: () => void;
  variantSupplierId: string;
  supplierId: string;
  productTitle: string;
  variantTitle: string;
  initialCost: string;
  initialLeadTimeDays: number;
  initialMinStock: number | null;
  initialMaxStock: number | null;
  initialMinOrderQty: number | null;
  /** Override submit action (e.g. /app/reorder to stay on current page) */
  action?: string;
  /** Called when save succeeds (when using custom action that returns JSON) */
  onSuccess?: () => void;
};

export function EditVariantSupplierModal({
  open,
  onClose,
  variantSupplierId,
  supplierId,
  productTitle,
  variantTitle,
  initialCost,
  initialLeadTimeDays,
  initialMinStock,
  initialMaxStock,
  initialMinOrderQty,
  action: actionOverride,
  onSuccess,
}: Props) {
  const action = actionOverride ?? `/app/suppliers/${supplierId}`;
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [cost, setCost] = useState(initialCost);
  const [leadTimeDays, setLeadTimeDays] = useState(String(initialLeadTimeDays));
  const [minStock, setMinStock] = useState(initialMinStock != null ? String(initialMinStock) : "");
  const [maxStock, setMaxStock] = useState(initialMaxStock != null ? String(initialMaxStock) : "");
  const [minOrderQty, setMinOrderQty] = useState(initialMinOrderQty != null ? String(initialMinOrderQty) : "");

  useEffect(() => {
    if (open) {
      setCost(initialCost);
      setLeadTimeDays(String(initialLeadTimeDays));
      setMinStock(initialMinStock != null ? String(initialMinStock) : "");
      setMaxStock(initialMaxStock != null ? String(initialMaxStock) : "");
      setMinOrderQty(initialMinOrderQty != null ? String(initialMinOrderQty) : "");
    }
  }, [open, initialCost, initialLeadTimeDays, initialMinStock, initialMaxStock, initialMinOrderQty]);

  useEffect(() => {
    if (onSuccess && fetcher.data?.success && fetcher.state === "idle") {
      onSuccess();
      onClose();
    }
  }, [fetcher.data, fetcher.state, onSuccess, onClose]);

  const handleSave = () => {
    const formData = new FormData();
    formData.set("intent", "updateVariantSupplier");
    formData.set("variantSupplierId", variantSupplierId);
    formData.set("cost", cost.trim() || "");
    formData.set("leadTimeDays", leadTimeDays);
    formData.set("minStock", minStock.trim() || "");
    formData.set("maxStock", maxStock.trim() || "");
    formData.set("minOrderQty", minOrderQty.trim() || "");
    fetcher.submit(formData, { method: "post", action });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit: ${productTitle} - ${variantTitle}`}
      size="small"
      primaryAction={{
        content: "Save",
        onAction: handleSave,
        loading: fetcher.state !== "idle",
      }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {fetcher.data && "error" in fetcher.data && fetcher.data.error && (
            <Banner tone="critical" onDismiss={() => {}}>
              {fetcher.data.error}
            </Banner>
          )}
          <TextField
            label={
              <InlineStack gap="100" blockAlign="center">
                <span>Unit cost</span>
                <Tooltip content="The cost per unit from this supplier. Used for margin calculations and purchase orders.">
                  <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                </Tooltip>
              </InlineStack>
            }
            value={cost}
            onChange={setCost}
            autoComplete="off"
            placeholder="0.00"
          />
          <TextField
            label={
              <InlineStack gap="100" blockAlign="center">
                <span>Lead time (days)</span>
                <Tooltip content="How many days until stock arrives after placing an order. Used for reorder suggestions.">
                  <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                </Tooltip>
              </InlineStack>
            }
            type="number"
            min={0}
            value={leadTimeDays}
            onChange={setLeadTimeDays}
            autoComplete="off"
          />
          <TextField
            label={
              <InlineStack gap="100" blockAlign="center">
                <span>Min stock</span>
                <Tooltip content="Reorder point. When stock falls below this level, the system suggests reordering. For most items, set to at least (daily sales × lead time).">
                  <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                </Tooltip>
              </InlineStack>
            }
            type="number"
            min={0}
            value={minStock}
            onChange={setMinStock}
            autoComplete="off"
          />
          <TextField
            label={
              <InlineStack gap="100" blockAlign="center">
                <span>Max stock</span>
                <Tooltip content="Maximum stock you want to hold. Suggested orders are based on sales velocity and will not exceed this ceiling.">
                  <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                </Tooltip>
              </InlineStack>
            }
            type="number"
            min={0}
            value={maxStock}
            onChange={setMaxStock}
            autoComplete="off"
          />
          <TextField
            label={
              <InlineStack gap="100" blockAlign="center">
                <span>Min order quantity</span>
                <Tooltip content="Minimum units required per order from this supplier.">
                  <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                </Tooltip>
              </InlineStack>
            }
            type="number"
            min={0}
            value={minOrderQty}
            onChange={setMinOrderQty}
            autoComplete="off"
          />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
