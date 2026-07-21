import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { encrypt } from "./encryption.server";

const prisma = new PrismaClient();

describe("webhook idempotency", () => {
  let testShopId: string;
  const testWebhookId = "test-webhook-id-" + Date.now();

  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    const shop = await prisma.shop.upsert({
      where: { domain: "test-idempotency.myshopify.com" },
      create: {
        domain: "test-idempotency.myshopify.com",
        encryptedAccessToken: encrypt("test-token"),
        isEnabled: true,
      },
      update: {},
    });
    testShopId = shop.id;
    await prisma.webhookEvent.deleteMany({ where: { webhookId: testWebhookId } });
  });

  afterEach(async () => {
    await prisma.webhookEvent.deleteMany({ where: { webhookId: testWebhookId } });
  });

  it("returns false when webhook not processed", async () => {
    const { isAlreadyProcessed } = await import("./webhook-idempotency.server");
    const result = await isAlreadyProcessed(testWebhookId);
    expect(result).toBe(false);
  });

  it("returns true after marking processed", async () => {
    const { isAlreadyProcessed, markProcessed } = await import("./webhook-idempotency.server");
    await markProcessed(testWebhookId, testShopId, "products/create");
    const result = await isAlreadyProcessed(testWebhookId);
    expect(result).toBe(true);
  });
});
