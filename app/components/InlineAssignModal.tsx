import { useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Modal,
  BlockStack,
  TextField,
  Select,
  Banner,
  InlineStack,
  Tooltip,
} from "@shopify/polaris";

type Props = {
  open: boolean;
  onClose: () => void;
  variantId: string;
  variantLabel: string;
  suppliers: { id: string; name: string }[];
  onSuccess?: () => void;
};

export function InlineAssignModal({
  open,
  onClose,
  variantId,
  variantLabel,
  suppliers,
  onSuccess,
}: Props) {
  const fetcher = useFetcher<{ success: boolean; error?: string }>();
  const [supplierId, setSupplierId] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState("7");

  const handleSave = () => {
    if (!supplierId || !unitCost.trim() || !leadTimeDays) return;
    const formData = new FormData();
    formData.set("intent", "inlineAssign");
    formData.set("variantId", variantId);
    formData.set("supplierId", supplierId);
    formData.set("unitCost", unitCost.trim());
    formData.set("leadTimeDays", leadTimeDays);
    fetcher.submit(formData, { method: "post", action: "/app/reorder" });
  };

  if (fetcher.data?.success && fetcher.state === "idle") {
    onSuccess?.();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Assign supplier: ${variantLabel}`}
      size="small"
      primaryAction={{
        content: "Save",
        onAction: handleSave,
        disabled: !supplierId || !unitCost.trim() || parseInt(leadTimeDays, 10) < 0 || fetcher.state !== "idle",
        loading: fetcher.state !== "idle",
      }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {fetcher.data && !fetcher.data.success && (
            <Banner tone="critical" onDismiss={() => {}}>
              {fetcher.data.error}
            </Banner>
          )}
          <Select
            label="Supplier"
            options={[{ label: "Select supplier", value: "" }, ...suppliers.map((s) => ({ label: s.name, value: s.id }))]}
            value={supplierId}
            onChange={setSupplierId}
          />
          <TextField
            label={
              <InlineStack gap="100" blockAlign="center">
                <span>Unit cost</span>
                <Tooltip content="The cost per unit from this supplier. Used for margin calculations and purchase orders.">
                  <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                </Tooltip>
              </InlineStack>
            }
            value={unitCost}
            onChange={setUnitCost}
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
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
