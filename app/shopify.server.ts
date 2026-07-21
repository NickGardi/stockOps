import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { encrypt } from "./lib/encryption.server";
import { logger } from "./lib/logger.server";
import { fullSync } from "./services/sync.server";
import { backfillOrders } from "./services/orders-backfill.server";

/** StockOps monthly subscription — $10 / 30 days after a 30-day free trial */
export const MONTHLY_PLAN = "StockOps Monthly";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: {
    [MONTHLY_PLAN]: {
      trialDays: 30,
      lineItems: [
        {
          amount: 10,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    expiringOfflineAccessTokens: false,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
  hooks: {
    afterAuth: async ({ session, admin }) => {
      try {
        await shopify.registerWebhooks({ session });
      } catch (err) {
        logger.warn("Webhook registration after auth failed", {
          shop: session.shop,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        const encryptedToken = encrypt(session.accessToken || "");
        const shop = await prisma.shop.upsert({
          where: { domain: session.shop },
          create: {
            domain: session.shop,
            encryptedAccessToken: encryptedToken,
            isEnabled: true,
          },
          update: {
            encryptedAccessToken: encryptedToken,
            isEnabled: true,
            updatedAt: new Date(),
          },
        });
        logger.info("Shop installed or token refreshed", { shop: session.shop });

        // Full sync + orders backfill in background (don't block OAuth response)
        fullSync(admin, shop.id)
          .then(async () => {
            const result = await backfillOrders(admin, shop.id, 60);
            if (!result.ok) {
              logger.warn("Orders backfill incomplete after install", {
                shop: session.shop,
                blocked: result.blocked,
                error: result.error,
              });
            }
          })
          .catch((err) =>
            logger.error("Sync/backfill failed after install", {
              shop: session.shop,
              error: err instanceof Error ? err.message : String(err),
            })
          );
      } catch (err) {
        logger.error("Failed to upsert shop record", {
          shop: session.shop,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  },
});

export default shopify;
export const apiVersion = ApiVersion.January25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

/** Use test charges on non-production (dev stores) so you aren't billed while building */
export function billingIsTest(): boolean {
  if (process.env.BILLING_TEST === "1") return true;
  if (process.env.BILLING_TEST === "0") return false;
  return process.env.NODE_ENV !== "production";
}

/**
 * Development stores can't approve real charges (no payment method), so we
 * always issue test charges to them. This is also required for App Store
 * review, since Shopify reviewers test billing on a dev store.
 */
export async function isDevelopmentStore(admin: {
  graphql: (query: string) => Promise<Response>;
}): Promise<boolean> {
  try {
    const response = await admin.graphql(
      `#graphql
      query ShopPlan {
        shop {
          plan {
            partnerDevelopment
          }
        }
      }`
    );
    const body = (await response.json()) as {
      data?: { shop?: { plan?: { partnerDevelopment?: boolean } } };
    };
    return Boolean(body.data?.shop?.plan?.partnerDevelopment);
  } catch (err) {
    logger.warn("Failed to check shop plan for billing test mode", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
