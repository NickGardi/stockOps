/**
 * Full sync of products, variants, locations, and inventory from Shopify.
 * Handles pagination and rate limits.
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { graphqlWithRetry } from "../lib/shopify-graphql.server";
import { logger } from "../lib/logger.server";

const PAGE_SIZE = 50;

export async function fullSync(admin: AdminApiContext, shopId: string): Promise<void> {
  logger.info("Starting full sync", { shopId });

  await syncLocations(admin, shopId);
  const syncedProductIds = await syncProductsAndVariants(admin, shopId);
  await deleteOrphanProducts(shopId, syncedProductIds);
  await syncInventoryLevels(admin, shopId);

  logger.info("Full sync complete", { shopId });
}

export async function syncLocations(admin: AdminApiContext, shopId: string): Promise<void> {
  let cursor: string | null = null;
  let hasNext = true;
  const shopifyIdsSeen = new Set<string>();

  while (hasNext) {
    const query = `#graphql
      query Locations($after: String) {
        locations(first: ${PAGE_SIZE}, after: $after, includeInactive: true, includeLegacy: true) {
          edges {
            node {
              id
              name
              isActive
            }
            cursor
          }
          pageInfo { hasNextPage }
        }
      }
    `;
    type LocationsResult = {
      locations: {
        edges: Array<{ node: { id: string; name: string; isActive: boolean }; cursor: string }>;
        pageInfo: { hasNextPage: boolean };
      };
    };
    const { data } = await graphqlWithRetry<LocationsResult>(
      admin as Parameters<typeof graphqlWithRetry>[0],
      query,
      { variables: { after: cursor } }
    );

    const locs = data?.locations;
    if (!locs) break;

    for (const edge of locs.edges) {
      const node = edge.node;
      const shopifyId = node.id.replace("gid://shopify/Location/", "");
      shopifyIdsSeen.add(shopifyId);
      await prisma.location.upsert({
        where: {
          shopId_shopifyLocationId: { shopId, shopifyLocationId: shopifyId },
        },
        create: {
          shopId,
          shopifyLocationId: shopifyId,
          name: node.name,
          isActive: node.isActive,
        },
        update: { name: node.name, isActive: node.isActive, updatedAt: new Date() },
      });
    }

    cursor = locs.edges[locs.edges.length - 1]?.cursor ?? null;
    hasNext = locs.pageInfo.hasNextPage;
  }

  // Remove locations that no longer exist in Shopify (only if we got data from API)
  const toRemove =
    shopifyIdsSeen.size > 0
      ? await prisma.location.findMany({
          where: { shopId, shopifyLocationId: { notIn: [...shopifyIdsSeen] } },
          select: { id: true, name: true },
        })
      : [];
  if (toRemove.length > 0) {
    await prisma.inventoryLevel.deleteMany({ where: { locationId: { in: toRemove.map((l) => l.id) } } });
    await prisma.location.deleteMany({ where: { id: { in: toRemove.map((l) => l.id) } } });
    logger.info("Removed locations no longer in Shopify", { shopId, removed: toRemove.map((l) => l.name) });
  }

  // Auto-set primary warehouse when store has exactly one location
  const locations = await prisma.location.findMany({ where: { shopId }, select: { id: true } });
  if (locations.length === 1) {
    const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { primaryWarehouseLocationId: true } });
    if (shop && !shop.primaryWarehouseLocationId) {
      await prisma.shop.update({
        where: { id: shopId },
        data: { primaryWarehouseLocationId: locations[0].id },
      });
      logger.info("Auto-set primary warehouse (single location)", { shopId, locationId: locations[0].id });
    }
  }
}

async function syncProductsAndVariants(admin: AdminApiContext, shopId: string): Promise<Set<string>> {
  const syncedProductIds = new Set<string>();
  let cursor: string | null = null;
  let hasNext = true;

  while (hasNext) {
    const query = `#graphql
      query Products($after: String) {
        products(first: ${PAGE_SIZE}, after: $after) {
          edges {
            node {
              id
              title
              handle
              status
              productType
              variants(first: 100) {
                edges {
                  node {
                    id
                    sku
                    title
                    price
                    inventoryItem { id tracked }
                  }
                }
              }
            }
            cursor
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    type ProductsResult = {
      products: {
        edges: Array<{
          node: {
            id: string;
            title: string;
            handle: string;
            status: string;
            productType: string | null;
            variants: { edges: Array<{ node: { id: string; sku: string | null; title: string; price: string; inventoryItem: { id: string; tracked: boolean } | null } }> };
          };
          cursor: string;
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };
    const { data } = await graphqlWithRetry<ProductsResult>(
      admin as Parameters<typeof graphqlWithRetry>[0],
      query,
      { variables: { after: cursor } }
    );

    const prods = data?.products;
    if (!prods) break;

    for (const edge of prods.edges) {
      const node = edge.node;
      const shopifyProductId = node.id.replace("gid://shopify/Product/", "");
      syncedProductIds.add(shopifyProductId);
      const product = await prisma.product.upsert({
        where: { shopId_shopifyProductId: { shopId, shopifyProductId } },
        create: {
          shopId,
          shopifyProductId,
          title: node.title,
          handle: node.handle,
          status: node.status,
          productType: node.productType ?? null,
        },
        update: {
          title: node.title,
          handle: node.handle,
          status: node.status,
          productType: node.productType ?? undefined,
          updatedAt: new Date(),
        },
      });

      for (const vEdge of node.variants.edges) {
        const v = vEdge.node;
        const shopifyVariantId = v.id.replace("gid://shopify/ProductVariant/", "");
        const invItem = v.inventoryItem;
        const invItemId = invItem?.id?.replace("gid://shopify/InventoryItem/", "") ?? null;
        const inventoryTracked = invItem?.tracked ?? true;
        await prisma.variant.upsert({
          where: { shopId_shopifyVariantId: { shopId, shopifyVariantId } },
          create: {
            productId: product.id,
            shopId,
            shopifyVariantId,
            shopifyInventoryItemId: invItemId,
            sku: v.sku,
            title: v.title,
            price: v.price,
            inventoryTracked,
          },
          update: {
            shopifyInventoryItemId: invItemId,
            sku: v.sku,
            title: v.title,
            price: v.price,
            inventoryTracked,
            updatedAt: new Date(),
          },
        });
      }
    }

    cursor = prods.pageInfo.endCursor ?? prods.edges[prods.edges.length - 1]?.cursor ?? null;
    hasNext = prods.pageInfo.hasNextPage;
  }

  return syncedProductIds;
}

async function deleteOrphanProducts(shopId: string, syncedProductIds: Set<string>): Promise<void> {
  const existing = await prisma.product.findMany({
    where: { shopId, deletedAt: null },
    include: {
      variants: { include: { purchaseOrderLines: { take: 1 } } },
    },
  });
  const withPOLines = new Set(
    existing.filter((p) => p.variants.some((v) => v.purchaseOrderLines.length > 0)).map((p) => p.shopifyProductId)
  );
  const toDelete = existing
    .filter((p) => !syncedProductIds.has(p.shopifyProductId) && !withPOLines.has(p.shopifyProductId))
    .map((p) => p.shopifyProductId);
  if (toDelete.length > 0) {
    await prisma.product.deleteMany({
      where: { shopId, shopifyProductId: { in: toDelete } },
    });
    logger.info("Deleted orphan products", { shopId, count: toDelete.length });
  }
}

async function syncInventoryLevels(admin: AdminApiContext, shopId: string): Promise<void> {
  const variants = await prisma.variant.findMany({
    where: { shopId },
    select: { id: true, shopifyInventoryItemId: true },
  });
  const withInvItem = variants.filter((v) => v.shopifyInventoryItemId);

  for (const variant of withInvItem) {
    const invItemId = `gid://shopify/InventoryItem/${variant.shopifyInventoryItemId}`;
    const query = `#graphql
      query InventoryLevels($id: ID!) {
        inventoryItem(id: $id) {
          inventoryLevels(first: 100) {
            edges {
              node {
                id
                location { id }
                quantities(names: ["available"]) { quantity }
              }
            }
          }
        }
      }
    `;
    type InventoryResult = {
      inventoryItem: {
        inventoryLevels: {
          edges: Array<{
            node: {
              location: { id: string };
              quantities: Array<{ quantity: number }>;
            };
          }>;
        };
      } | null;
    };
    const { data } = await graphqlWithRetry<InventoryResult>(
      admin as Parameters<typeof graphqlWithRetry>[0],
      query,
      { variables: { id: invItemId } }
    );

    const invItem = data?.inventoryItem;
    if (!invItem?.inventoryLevels) continue;

    const locationIds = await prisma.location.findMany({ where: { shopId }, select: { id: true, shopifyLocationId: true } });
    const locById = new Map(locationIds.map((l) => [l.shopifyLocationId, l.id]));

    for (const edge of invItem.inventoryLevels.edges) {
      const node = edge.node;
      const shopifyLocId = node.location.id.replace("gid://shopify/Location/", "");
      const locationId = locById.get(shopifyLocId);
      if (!locationId) continue;

      const available = node.quantities[0]?.quantity ?? 0;
      await prisma.inventoryLevel.upsert({
        where: { variantId_locationId: { variantId: variant.id, locationId } },
        create: { shopId, variantId: variant.id, locationId, available },
        update: { available, updatedAt: new Date() },
      });
    }
  }
}
