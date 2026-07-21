/**
 * Location CRUD - syncs to Shopify store.
 * Create, edit, deactivate, delete locations via Shopify Admin API.
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { graphqlWithRetry } from "../lib/shopify-graphql.server";
import { logger } from "../lib/logger.server";

type GraphQLClient = Parameters<typeof graphqlWithRetry>[0];

export type LocationAddressInput = {
  address1?: string;
  address2?: string;
  city?: string;
  provinceCode?: string;
  countryCode: string;
  zip?: string;
  phone?: string;
};

export async function createLocation(
  admin: GraphQLClient,
  shopId: string,
  input: { name: string; address: LocationAddressInput; fulfillsOnlineOrders?: boolean }
): Promise<{ success: boolean; locationId?: string; error?: string }> {
  const mutation = `#graphql
    mutation locationAdd($input: LocationAddInput!) {
      locationAdd(input: $input) {
        location { id name }
        userErrors { message field }
      }
    }
  `;

  const variables = {
    input: {
      name: input.name,
      address: {
        ...input.address,
        countryCode: input.address.countryCode || "US",
      },
      fulfillsOnlineOrders: input.fulfillsOnlineOrders ?? true,
    },
  };

  try {
    const { data } = await graphqlWithRetry<{
      locationAdd?: {
        location?: { id: string; name: string };
        userErrors: Array<{ message: string; field?: string[] }>;
      };
    }>(admin, mutation, { variables });

    const errors = data?.locationAdd?.userErrors ?? [];
    if (errors.length > 0) {
      return { success: false, error: errors.map((e) => e.message).join("; ") };
    }

    const location = data?.locationAdd?.location;
    if (!location?.id) {
      return { success: false, error: "No location returned from Shopify" };
    }

    const shopifyId = location.id.replace("gid://shopify/Location/", "");
    const created = await prisma.location.create({
      data: {
        shopId,
        shopifyLocationId: shopifyId,
        name: location.name,
        isActive: true,
      },
    });

    return { success: true, locationId: created.id };
  } catch (err) {
    logger.error("Create location failed", {
      shopId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export async function updateLocation(
  admin: GraphQLClient,
  shopId: string,
  locationId: string,
  input: { name?: string; address?: LocationAddressInput; fulfillsOnlineOrders?: boolean }
): Promise<{ success: boolean; error?: string }> {
  const loc = await prisma.location.findFirst({
    where: { id: locationId, shopId },
  });
  if (!loc) return { success: false, error: "Location not found" };

  const shopifyGid = `gid://shopify/Location/${loc.shopifyLocationId}`;

  const mutation = `#graphql
    mutation locationEdit($id: ID!, $input: LocationEditInput!) {
      locationEdit(id: $id, input: $input) {
        location { id name }
        userErrors { message field }
      }
    }
  `;

  const editInput: Record<string, unknown> = {};
  if (input.name != null) editInput.name = input.name;
  if (input.fulfillsOnlineOrders != null) editInput.fulfillsOnlineOrders = input.fulfillsOnlineOrders;
  if (input.address != null) {
    editInput.address = {
      ...input.address,
      countryCode: input.address.countryCode || "US",
    };
  }

  if (Object.keys(editInput).length === 0) {
    return { success: true };
  }

  const variables = { id: shopifyGid, input: editInput };

  try {
    const { data } = await graphqlWithRetry<{
      locationEdit?: {
        location?: { id: string; name: string };
        userErrors: Array<{ message: string; field?: string[] }>;
      };
    }>(admin, mutation, { variables });

    const errors = data?.locationEdit?.userErrors ?? [];
    if (errors.length > 0) {
      return { success: false, error: errors.map((e) => e.message).join("; ") };
    }

    const location = data?.locationEdit?.location;
    if (location?.name) {
      await prisma.location.update({
        where: { id: locationId },
        data: { name: location.name, updatedAt: new Date() },
      });
    }

    return { success: true };
  } catch (err) {
    logger.error("Update location failed", {
      shopId,
      locationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export async function deactivateLocation(
  admin: GraphQLClient,
  shopId: string,
  locationId: string,
  destinationLocationId: string
): Promise<{ success: boolean; error?: string }> {
  const loc = await prisma.location.findFirst({
    where: { id: locationId, shopId },
  });
  if (!loc) return { success: false, error: "Location not found" };

  const dest = await prisma.location.findFirst({
    where: { id: destinationLocationId, shopId },
  });
  if (!dest) return { success: false, error: "Destination location not found" };

  const shopifyGid = `gid://shopify/Location/${loc.shopifyLocationId}`;
  const destGid = `gid://shopify/Location/${dest.shopifyLocationId}`;

  const mutation = `#graphql
    mutation locationDeactivate($locationId: ID!, $destinationLocationId: ID!, $idempotencyKey: String!) {
      locationDeactivate(locationId: $locationId, destinationLocationId: $destinationLocationId) @idempotent(key: $idempotencyKey) {
        location { id isActive }
        locationDeactivateUserErrors { message code field }
      }
    }
  `;

  const variables = {
    locationId: shopifyGid,
    destinationLocationId: destGid,
    idempotencyKey: `deactivate-${locationId}-${Date.now()}`,
  };

  try {
    const { data } = await graphqlWithRetry<{
      locationDeactivate?: {
        location?: { id: string; isActive: boolean };
        locationDeactivateUserErrors: Array<{ message: string; code?: string; field?: string[] }>;
      };
    }>(admin, mutation, { variables });

    const errors = data?.locationDeactivate?.locationDeactivateUserErrors ?? [];
    if (errors.length > 0) {
      return { success: false, error: errors.map((e) => e.message).join("; ") };
    }

    await prisma.location.update({
      where: { id: locationId },
      data: { isActive: false, updatedAt: new Date() },
    });

    return { success: true };
  } catch (err) {
    logger.error("Deactivate location failed", {
      shopId,
      locationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export async function fetchLocationFromShopify(
  admin: GraphQLClient,
  shopifyLocationId: string
): Promise<{
  id: string;
  name: string;
  isActive: boolean;
  address?: {
    address1?: string;
    address2?: string;
    city?: string;
    provinceCode?: string;
    countryCode: string;
    zip?: string;
    phone?: string;
  };
} | null> {
  const query = `#graphql
    query location($id: ID!) {
      location(id: $id) {
        id
        name
        isActive
        address {
          address1
          address2
          city
          provinceCode
          countryCode
          zip
          phone
        }
      }
    }
  `;

  const { data } = await graphqlWithRetry<{
    location?: {
      id: string;
      name: string;
      isActive: boolean;
      address?: {
        address1?: string;
        address2?: string;
        city?: string;
        provinceCode?: string;
        countryCode: string;
        zip?: string;
        phone?: string;
      };
    };
  }>(admin, query, {
    variables: { id: `gid://shopify/Location/${shopifyLocationId}` },
  });

  return data?.location ?? null;
}

export async function deleteLocation(
  admin: GraphQLClient,
  shopId: string,
  locationId: string
): Promise<{ success: boolean; error?: string }> {
  const loc = await prisma.location.findFirst({
    where: { id: locationId, shopId },
  });
  if (!loc) return { success: false, error: "Location not found" };
  if (loc.isActive) {
    return { success: false, error: "Location must be deactivated before deletion. Use Deactivate first." };
  }

  const shopifyGid = `gid://shopify/Location/${loc.shopifyLocationId}`;

  const mutation = `#graphql
    mutation locationDelete($locationId: ID!) {
      locationDelete(locationId: $locationId) {
        deletedLocationId
        locationDeleteUserErrors { message code field }
      }
    }
  `;

  const variables = { locationId: shopifyGid };

  try {
    const { data } = await graphqlWithRetry<{
      locationDelete?: {
        deletedLocationId: string | null;
        locationDeleteUserErrors: Array<{ message: string; code?: string; field?: string[] }>;
      };
    }>(admin, mutation, { variables });

    const errors = data?.locationDelete?.locationDeleteUserErrors ?? [];
    if (errors.length > 0) {
      return { success: false, error: errors.map((e) => e.message).join("; ") };
    }

    if (data?.locationDelete?.deletedLocationId) {
      await prisma.location.delete({
        where: { id: locationId },
      });
    }

    return { success: true };
  } catch (err) {
    logger.error("Delete location failed", {
      shopId,
      locationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
