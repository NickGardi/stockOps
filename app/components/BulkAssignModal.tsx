import { useState, useEffect, useCallback } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Modal,
  BlockStack,
  InlineStack,
  Button,
  TextField,
  Select,
  Checkbox,
  Box,
  Text,
  Banner,
  Tooltip,
  DataTable,
} from "@shopify/polaris";
import type { VariantForAssign } from "../services/supplier-assignment.server";

type AssignData = {
  suppliers: { id: string; name: string }[];
  variants: VariantForAssign[];
  total: number;
};

type AssignResult = {
  success: boolean;
  assigned?: number;
  error?: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onSuccess?: (data?: AssignResult) => void;
  /** Pre-select this supplier when opened from supplier detail page */
  preSelectedSupplierId?: string;
};

export function BulkAssignModal({ open, onClose, onSuccess, preSelectedSupplierId }: Props) {
  const dataFetcher = useFetcher<AssignData>();
  const assignFetcher = useFetcher<AssignResult>();
  const [supplierId, setSupplierId] = useState(preSelectedSupplierId || "");
  const [search, setSearch] = useState("");
  const [unassignedOnly, setUnassignedOnly] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [unitCost, setUnitCost] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState("7");
  const [supplierSku, setSupplierSku] = useState("");
  const [lastAssignedCount, setLastAssignedCount] = useState<number | null>(null);

  const loadData = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (unassignedOnly) params.set("unassignedOnly", "1");
    params.set("limit", "100");
    dataFetcher.load(`/app/reorder/assign-data?${params}`);
  }, [search, unassignedOnly]);

  useEffect(() => {
    if (open) {
      loadData();
      if (preSelectedSupplierId) setSupplierId(preSelectedSupplierId);
    }
  }, [open, loadData, preSelectedSupplierId]);

  useEffect(() => {
    if (assignFetcher.data?.success && assignFetcher.state === "idle") {
      onSuccess?.(assignFetcher.data);
      setLastAssignedCount(assignFetcher.data?.assigned ?? 0);
      setSelectedIds(new Set());
      loadData();
    }
  }, [assignFetcher.data, assignFetcher.state, onSuccess, loadData]);

  const reset = () => {
    setSupplierId("");
    setSearch("");
    setUnassignedOnly(true);
    setSelectedIds(new Set());
    setUnitCost("");
    setLeadTimeDays("7");
    setSupplierSku("");
    setLastAssignedCount(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const data = dataFetcher.data;
  const variants = data?.variants ?? [];
  const suppliers = data?.suppliers ?? [];

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === variants.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(variants.map((v) => v.id)));
    }
  };

  const handleAssign = () => {
    if (!supplierId || selectedIds.size === 0) return;
    const formData = new FormData();
    formData.set("intent", "bulkAssign");
    formData.set("variantIds", JSON.stringify([...selectedIds]));
    formData.set("supplierId", supplierId);
    if (unitCost.trim()) formData.set("unitCost", unitCost.trim());
    if (leadTimeDays && parseInt(leadTimeDays, 10) >= 0) formData.set("leadTimeDays", leadTimeDays);
    if (supplierSku) formData.set("supplierSku", supplierSku);
    assignFetcher.submit(formData, { method: "post", action: "/app/reorder" });
  };

  const canAssign = !!supplierId && selectedIds.size > 0;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Assign suppliers to SKUs"
      size="large"
      primaryAction={{
        content: "Assign to supplier",
        onAction: handleAssign,
        disabled: !canAssign || assignFetcher.state !== "idle",
        loading: assignFetcher.state !== "idle",
      }}
      secondaryActions={[{ content: "Cancel", onAction: handleClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {assignFetcher.data && !assignFetcher.data.success && (
            <Banner tone="critical" onDismiss={() => {}}>
              {assignFetcher.data.error}
            </Banner>
          )}
          {lastAssignedCount != null && (
            <Banner tone="success" onDismiss={() => setLastAssignedCount(null)}>
              {lastAssignedCount} variant{lastAssignedCount !== 1 ? "s" : ""} assigned. Select more and assign to the same or different supplier.
            </Banner>
          )}
          <Text as="p" variant="bodyMd" tone="subdued">
            Select a supplier and variants, then assign. You can make multiple assignments without closing.
          </Text>
          <InlineStack gap="300" wrap blockAlign="end">
            <Box minWidth="200px">
              <Select
                label="Supplier"
                options={[{ label: "Select supplier", value: "" }, ...suppliers.map((s) => ({ label: s.name, value: s.id }))]}
                value={supplierId}
                onChange={setSupplierId}
              />
            </Box>
            <Box minWidth="200px">
              <TextField
                label="Search"
                labelHidden
                value={search}
                onChange={setSearch}
                placeholder="Product, SKU..."
                autoComplete="off"
              />
            </Box>
            <Checkbox
              label="Unassigned only"
              checked={unassignedOnly}
              onChange={setUnassignedOnly}
            />
            <Button onClick={loadData}>Apply</Button>
          </InlineStack>
          <InlineStack gap="300" wrap blockAlign="end">
            <Box minWidth="120px">
              <TextField
                label={
                  <InlineStack gap="100" blockAlign="center">
                    <span>Unit cost (optional)</span>
                    <Tooltip content="Cost per unit. Applied to all selected variants. Leave blank to add later.">
                      <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                    </Tooltip>
                  </InlineStack>
                }
                type="text"
                value={unitCost}
                onChange={setUnitCost}
                autoComplete="off"
                placeholder="0.00"
              />
            </Box>
            <Box minWidth="120px">
              <TextField
                label={
                  <InlineStack gap="100" blockAlign="center">
                    <span>Lead time (days)</span>
                    <Tooltip content="Days until stock arrives after ordering. Used for reorder suggestions.">
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
            </Box>
            <Box minWidth="150px">
              <TextField
                label={
                  <InlineStack gap="100" blockAlign="center">
                    <span>Supplier SKU (optional)</span>
                    <Tooltip content="The SKU or product code used by this supplier for this item.">
                      <span style={{ cursor: "help", opacity: 0.4 }}>?</span>
                    </Tooltip>
                  </InlineStack>
                }
                value={supplierSku}
                onChange={setSupplierSku}
                autoComplete="off"
                placeholder="Supplier's SKU"
              />
            </Box>
          </InlineStack>
          <InlineStack gap="200" blockAlign="center">
            <Checkbox
              label="Select all"
              checked={variants.length > 0 && selectedIds.size === variants.length}
              onChange={toggleSelectAll}
            />
            <Text as="p" variant="bodyMd" tone="subdued">
              {selectedIds.size} of {variants.length} selected
            </Text>
          </InlineStack>
          <div className="bulk-assign-table-wrapper">
            {dataFetcher.state === "loading" ? (
              <Box padding="400">
                <Text as="p" variant="bodyMd" tone="subdued">
                  Loading...
                </Text>
              </Box>
            ) : variants.length === 0 ? (
              <Box padding="400">
                <Text as="p" variant="bodyMd" tone="subdued">
                  No variants match your filters.
                </Text>
              </Box>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text", "numeric", "numeric"]}
                headings={["", "Product", "Variant", "SKU", "Supplier", "On Hand", "Sold 30d"]}
                rows={variants.map((v) => [
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
                  v.supplierName || "—",
                  v.onHand,
                  v.soldLast30Days.toFixed(0),
                ])}
              />
            )}
          </div>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
