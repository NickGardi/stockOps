import { describe, it, expect } from "vitest";
import prisma from "../db.server";
import { receiveLine } from "./receiving.server";

const mockAdmin = {} as Parameters<typeof receiveLine>[0];

describe("receiving.server", () => {
  describe("receiveLine - receiving location guard", () => {
    it("rejects when neither PO nor shop has a receiving location", async () => {
      const line = await prisma.purchaseOrderLine.findFirst({
        include: { purchaseOrder: true, variant: true },
      });
      if (!line) return;

      const shopId = line.purchaseOrder.shopId;
      const originalShop = await prisma.shop.findUnique({
        where: { id: shopId },
        select: { primaryWarehouseLocationId: true },
      });
      const originalPoReceiving = line.purchaseOrder.receivingLocationId;
      if (!originalShop) return;

      try {
        await prisma.shop.update({
          where: { id: shopId },
          data: { primaryWarehouseLocationId: null },
        });
        await prisma.purchaseOrder.update({
          where: { id: line.purchaseOrderId },
          data: { receivingLocationId: null },
        });

        const result = await receiveLine(
          mockAdmin,
          shopId,
          line.id,
          line.variantId,
          "any-location-id",
          1,
          `test-guard-no-location-${Date.now()}`
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain("Receiving location not set");
      } finally {
        await prisma.shop.update({
          where: { id: shopId },
          data: { primaryWarehouseLocationId: originalShop.primaryWarehouseLocationId },
        });
        await prisma.purchaseOrder.update({
          where: { id: line.purchaseOrderId },
          data: { receivingLocationId: originalPoReceiving },
        });
      }
    });

    it("rejects when location is not the PO receiving location", async () => {
      const line = await prisma.purchaseOrderLine.findFirst({
        include: { purchaseOrder: true },
      });
      if (!line) return;

      const shop = await prisma.shop.findUnique({
        where: { id: line.purchaseOrder.shopId },
        select: { id: true, primaryWarehouseLocationId: true },
      });
      if (!shop) return;

      const effectiveLocationId =
        line.purchaseOrder.receivingLocationId ?? shop.primaryWarehouseLocationId;
      if (!effectiveLocationId) return;

      const otherLocation = await prisma.location.findFirst({
        where: { shopId: shop.id, id: { not: effectiveLocationId } },
        select: { id: true },
      });
      if (!otherLocation) return;

      const result = await receiveLine(
        mockAdmin,
        shop.id,
        line.id,
        line.variantId,
        otherLocation.id,
        1,
        `test-guard-wrong-location-${Date.now()}`
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Receiving must be into the PO's receiving location");
    });
  });
});
