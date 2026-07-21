import { describe, it, expect, beforeEach } from "vitest";
import prisma from "../db.server";
import { getReorderSuggestions } from "./reorder.server";

describe("reorder.server", () => {
  describe("getReorderSuggestions", () => {
    it("returns empty array when shop has no primary warehouse", async () => {
      let shop = await prisma.shop.findFirst({
        where: { primaryWarehouseLocationId: null },
        select: { id: true },
      });
      let originalPrimary: string | null = null;
      if (!shop) {
        shop = await prisma.shop.findFirst({ select: { id: true, primaryWarehouseLocationId: true } });
        if (!shop) return;
        originalPrimary = shop.primaryWarehouseLocationId;
        await prisma.shop.update({
          where: { id: shop.id },
          data: { primaryWarehouseLocationId: null },
        });
      }
      try {
        const rows = await getReorderSuggestions(shop!.id);
        expect(rows).toEqual([]);
      } finally {
        if (originalPrimary !== null && shop) {
          await prisma.shop.update({
            where: { id: shop.id },
            data: { primaryWarehouseLocationId: originalPrimary },
          });
        }
      }
    });

    it("uses only primary warehouse inventory for reorder calculation", async () => {
      const shop = await prisma.shop.findFirst({
        where: { primaryWarehouseLocationId: { not: null } },
        include: { primaryWarehouseLocation: true },
      });
      if (!shop?.primaryWarehouseLocation) return;

      const rows = await getReorderSuggestions(shop.id);
      for (const row of rows) {
        expect(row.locationId).toBe(shop.primaryWarehouseLocationId);
        expect(row.locationName).toBe(shop.primaryWarehouseLocation!.name);
      }
    });

    it("returns empty when primary warehouse is inactive", async () => {
      const shop = await prisma.shop.findFirst({
        where: { primaryWarehouseLocationId: { not: null } },
        include: { primaryWarehouseLocation: true },
      });
      if (!shop?.primaryWarehouseLocation) return;

      await prisma.location.update({
        where: { id: shop.primaryWarehouseLocationId! },
        data: { isActive: false },
      });
      try {
        const rows = await getReorderSuggestions(shop.id);
        expect(rows).toEqual([]);
      } finally {
        await prisma.location.update({
          where: { id: shop.primaryWarehouseLocationId! },
          data: { isActive: true },
        });
      }
    });
  });
});
