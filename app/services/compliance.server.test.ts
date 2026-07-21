import { describe, expect, it, vi, beforeEach } from "vitest";

const deleteManySession = vi.fn();
const findUniqueShop = vi.fn();
const deleteShop = vi.fn();

vi.mock("../db.server", () => ({
  default: {
    session: { deleteMany: (...args: unknown[]) => deleteManySession(...args) },
    shop: {
      findUnique: (...args: unknown[]) => findUniqueShop(...args),
      delete: (...args: unknown[]) => deleteShop(...args),
    },
  },
}));

vi.mock("../lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  handleCustomersDataRequest,
  handleCustomersRedact,
  purgeShopByDomain,
} from "./compliance.server";

describe("compliance.server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("acknowledges customers/data_request without error", async () => {
    await expect(
      handleCustomersDataRequest({
        shop_domain: "test.myshopify.com",
        customer: { id: 1, email: "a@b.com" },
        orders_requested: [1, 2],
      })
    ).resolves.toBeUndefined();
  });

  it("acknowledges customers/redact without error", async () => {
    await expect(
      handleCustomersRedact({
        shop_domain: "test.myshopify.com",
        customer: { id: 1 },
        orders_to_redact: [9],
      })
    ).resolves.toBeUndefined();
  });

  it("purges sessions and shop on shop redact", async () => {
    findUniqueShop.mockResolvedValue({ id: "shop_1", domain: "test.myshopify.com" });
    deleteManySession.mockResolvedValue({ count: 1 });
    deleteShop.mockResolvedValue({ id: "shop_1" });

    await purgeShopByDomain("test.myshopify.com");

    expect(deleteManySession).toHaveBeenCalledWith({
      where: { shop: "test.myshopify.com" },
    });
    expect(deleteShop).toHaveBeenCalledWith({ where: { id: "shop_1" } });
  });

  it("no-ops purge when shop already gone", async () => {
    findUniqueShop.mockResolvedValue(null);
    await purgeShopByDomain("gone.myshopify.com");
    expect(deleteShop).not.toHaveBeenCalled();
  });
});
