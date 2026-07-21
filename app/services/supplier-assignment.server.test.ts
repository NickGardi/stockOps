import { describe, it, expect } from "vitest";
import prisma from "../db.server";
import {
  getUnassignedVariantCount,
  bulkAssignVariants,
  hasCompleteSupplierDetails,
  getVariantsForCompletion,
  updateVariantSupplierDetails,
} from "./supplier-assignment.server";

describe("supplier-assignment.server", () => {
  describe("getUnassignedVariantCount", () => {
    it("returns 0 for shop with no variants", async () => {
      const count = await getUnassignedVariantCount("non-existent-shop");
      expect(count).toBe(0);
    });
  });

  describe("hasCompleteSupplierDetails", () => {
    it("returns true when cost and leadTimeDays are valid", () => {
      expect(hasCompleteSupplierDetails({ cost: "10.50", leadTimeDays: 7 })).toBe(true);
      expect(hasCompleteSupplierDetails({ cost: "0", leadTimeDays: 0 })).toBe(true);
    });
    it("returns false when cost is missing or invalid", () => {
      expect(hasCompleteSupplierDetails({ cost: null, leadTimeDays: 7 })).toBe(false);
      expect(hasCompleteSupplierDetails({ cost: "", leadTimeDays: 7 })).toBe(false);
      expect(hasCompleteSupplierDetails({ cost: "abc", leadTimeDays: 7 })).toBe(false);
    });
    it("returns false when leadTimeDays is missing or invalid", () => {
      expect(hasCompleteSupplierDetails({ cost: "10", leadTimeDays: null })).toBe(false);
      expect(hasCompleteSupplierDetails({ cost: "10", leadTimeDays: -1 })).toBe(false);
    });
  });

  describe("bulkAssignVariants with optional defaults", () => {
    it("creates variant_supplier with supplier default lead time when not provided", async () => {
      const shop = await prisma.shop.findFirst({ select: { id: true } });
      const supplier = await prisma.supplier.findFirst({ where: { shopId: shop!.id }, select: { id: true } });
      const variant = await prisma.variant.findFirst({ where: { shopId: shop!.id }, select: { id: true } });
      if (!shop || !supplier || !variant) return;

      await prisma.supplier.update({
        where: { id: supplier.id },
        data: { defaultLeadTimeDays: 14 },
      });
      try {
        const result = await bulkAssignVariants(shop.id, [variant.id], supplier.id, {});
        expect(result.assigned).toBe(1);
        const vs = await prisma.variantSupplier.findFirst({ where: { variantId: variant.id } });
        expect(vs?.leadTimeDays).toBe(14);
      } finally {
        await prisma.variantSupplier.deleteMany({ where: { variantId: variant.id } });
        await prisma.supplier.update({
          where: { id: supplier.id },
          data: { defaultLeadTimeDays: null },
        });
      }
    });
  });

  describe("getVariantsForCompletion and updateVariantSupplierDetails", () => {
    it("returns variants with supplier and updates details", async () => {
      const vs = await prisma.variantSupplier.findFirst({
        include: { variant: true },
      });
      if (!vs) return;

      const variants = await getVariantsForCompletion(vs.variant.shopId, [vs.variantId]);
      expect(variants.length).toBe(1);
      expect(variants[0].variantSupplierId).toBe(vs.id);

      const result = await updateVariantSupplierDetails(vs.variant.shopId, [
        { variantSupplierId: vs.id, cost: "25.99", leadTimeDays: 5 },
      ]);
      expect(result.updated).toBe(1);

      const updated = await prisma.variantSupplier.findUnique({ where: { id: vs.id } });
      expect(updated?.cost).toBe("25.99");
      expect(updated?.leadTimeDays).toBe(5);
    });
  });
});
