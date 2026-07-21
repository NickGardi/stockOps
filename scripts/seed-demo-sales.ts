#!/usr/bin/env node
/**
 * DEV-ONLY: Seed demo sales for 10 variants so UI doesn't look dead in dev stores.
 * Usage: npx ts-node scripts/seed-demo-sales.ts --shop=your-dev-store.myshopify.com
 * Or: SHOP=your-dev-store.myshopify.com npx ts-node scripts/seed-demo-sales.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function recordSales(
  shopId: string,
  variantId: string,
  date: Date,
  unitsSold: number
): Promise<void> {
  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  await prisma.salesDaily.upsert({
    where: { variantId_date: { variantId, date: dateOnly } },
    create: { shopId, variantId, date: dateOnly, unitsSold },
    update: { unitsSold: { increment: unitsSold }, updatedAt: new Date() },
  });
}

async function main() {
  const shopArg = process.argv.find((a) => a.startsWith("--shop=")) || process.env.SHOP;
  const shopDomain = shopArg?.replace("--shop=", "")?.trim();
  if (!shopDomain) {
    console.error("Usage: npx ts-node scripts/seed-demo-sales.ts --shop=your-dev-store.myshopify.com");
    process.exit(1);
  }

  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) {
    console.error("Shop not found:", shopDomain);
    process.exit(1);
  }

  const variants = await prisma.variant.findMany({
    where: { shopId: shop.id },
    take: 10,
    select: { id: true },
  });

  if (variants.length === 0) {
    console.error("No variants found. Sync products first.");
    process.exit(1);
  }

  const now = new Date();
  let totalRecorded = 0;
  for (let i = 0; i < 30; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    for (const v of variants) {
      const qty = Math.floor(Math.random() * 3) + 1;
      await recordSales(shop.id, v.id, date, qty);
      totalRecorded++;
    }
  }

  console.log(`Seeded demo sales: ${variants.length} variants × 30 days = ${totalRecorded} records`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
