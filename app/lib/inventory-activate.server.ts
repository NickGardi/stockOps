/**
 * Ensure a Shopify inventory item can be adjusted at a location.
 * Shopify returns "not stocked at the location" until the item is activated there.
 */

import { graphqlWithRetry, type GraphQLClient } from "./shopify-graphql.server";
import { logger } from "./logger.server";

const ALREADY_ACTIVE_HINTS = [
  "already activated",
  "already stocked",
  "already enabled",
];

function isBenignActivationError(message: string): boolean {
  const lower = message.toLowerCase();
  return ALREADY_ACTIVE_HINTS.some((h) => lower.includes(h));
}

/**
 * Activate inventoryItemId at locationId (Shopify GIDs). Safe to call if already active.
 */
export async function ensureInventoryActivatedAtLocation(
  admin: GraphQLClient,
  inventoryItemGid: string,
  locationGid: string
): Promise<{ success: boolean; error?: string }> {
  const mutation = `#graphql
    mutation inventoryBulkToggleActivation(
      $inventoryItemId: ID!
      $inventoryItemUpdates: [InventoryBulkToggleActivationInput!]!
    ) {
      inventoryBulkToggleActivation(
        inventoryItemId: $inventoryItemId
        inventoryItemUpdates: $inventoryItemUpdates
      ) {
        inventoryItem { id }
        userErrors { field message code }
      }
    }
  `;

  try {
    const { data } = await graphqlWithRetry<{
      inventoryBulkToggleActivation?: {
        userErrors: Array<{ field: string[]; message: string; code?: string }>;
      };
    }>(admin, mutation, {
      variables: {
        inventoryItemId: inventoryItemGid,
        inventoryItemUpdates: [{ locationId: locationGid, activate: true }],
      },
    });

    const errors = data?.inventoryBulkToggleActivation?.userErrors ?? [];
    const realErrors = errors.filter((e) => !isBenignActivationError(e.message));
    if (realErrors.length > 0) {
      return { success: false, error: realErrors.map((e) => e.message).join("; ") };
    }
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isBenignActivationError(message)) return { success: true };
    logger.error("Failed to activate inventory at location", {
      inventoryItemGid,
      locationGid,
      error: message,
    });
    return { success: false, error: message };
  }
}

/**
 * Activate many inventory items at one location (deduped).
 */
export async function ensureInventoryItemsActivatedAtLocation(
  admin: GraphQLClient,
  inventoryItemGids: string[],
  locationGid: string
): Promise<{ success: boolean; error?: string }> {
  const unique = [...new Set(inventoryItemGids.filter(Boolean))];
  for (const inventoryItemGid of unique) {
    const result = await ensureInventoryActivatedAtLocation(admin, inventoryItemGid, locationGid);
    if (!result.success) return result;
  }
  return { success: true };
}
