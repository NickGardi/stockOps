/**
 * Webhook idempotency: skip if webhookId already processed.
 * Returns true if already seen (caller should return 200), false if new.
 */

import prisma from "../db.server";

export async function isAlreadyProcessed(webhookId: string): Promise<boolean> {
  const existing = await prisma.webhookEvent.findUnique({
    where: { webhookId },
  });
  return !!existing;
}

export async function markProcessed(webhookId: string, shopId: string, topic: string): Promise<void> {
  await prisma.webhookEvent.upsert({
    where: { webhookId },
    create: { webhookId, shopId, topic },
    update: {}, // no-op if exists
  });
}
