/**
 * GDPR / privacy compliance helpers.
 * StockOps does not store customer PII (names, emails, addresses).
 * Sales are aggregated by variant + day only.
 */

import prisma from "../db.server";
import { logger } from "../lib/logger.server";

export async function handleCustomersDataRequest(payload: {
  shop_domain?: string;
  customer?: { id?: number; email?: string; phone?: string };
  orders_requested?: number[];
}): Promise<void> {
  logger.info("Compliance customers/data_request received", {
    shop: payload.shop_domain,
    customerId: payload.customer?.id,
    ordersRequested: payload.orders_requested?.length ?? 0,
  });
  // No customer PII is stored. Merchant can be told we hold no customer personal data.
}

export async function handleCustomersRedact(payload: {
  shop_domain?: string;
  customer?: { id?: number; email?: string; phone?: string };
  orders_to_redact?: number[];
}): Promise<void> {
  logger.info("Compliance customers/redact received", {
    shop: payload.shop_domain,
    customerId: payload.customer?.id,
    ordersToRedact: payload.orders_to_redact?.length ?? 0,
  });
  // Nothing to delete — we never store customer-level records.
}

/** Purge all shop data (also used 48h after uninstall via shop/redact). */
export async function purgeShopByDomain(shopDomain: string): Promise<void> {
  logger.info("Purging shop data", { shop: shopDomain });

  await prisma.session.deleteMany({ where: { shop: shopDomain } });

  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) {
    logger.info("Shop already purged or never existed", { shop: shopDomain });
    return;
  }

  // Cascades delete related rows (products, POs, sales, etc.)
  await prisma.shop.delete({ where: { id: shop.id } });
  logger.info("Shop data purged", { shop: shopDomain, shopId: shop.id });
}
