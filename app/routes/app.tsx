import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import {
  authenticate,
  billingIsTest,
  isDevelopmentStore,
  MONTHLY_PLAN,
} from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

function shouldEnforceBilling(): boolean {
  if (process.env.BILLING_ENFORCE === "0") return false;
  if (process.env.BILLING_ENFORCE === "1") return true;
  return process.env.NODE_ENV === "production";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const path = url.pathname;
  const isBillingRoute =
    path === "/app/billing" || path.endsWith("/app/billing");

  // Require an active plan (or accepted trial) everywhere except the billing page.
  if (shouldEnforceBilling() && !isBillingRoute) {
    const isTest = billingIsTest() || (await isDevelopmentStore(admin));
    await billing.require({
      plans: [MONTHLY_PLAN],
      isTest,
      onFailure: async () =>
        billing.request({
          plan: MONTHLY_PLAN,
          isTest,
          returnUrl: `https://${session.shop}/admin/apps/${process.env.SHOPIFY_API_KEY}/app/billing?subscribed=1`,
        }),
    });
  }

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Dashboard
        </Link>
        <Link to="/app/stock">Inventory</Link>
        <Link to="/app/reorder">Reorder</Link>
        <Link to="/app/purchase-orders">Purchase Orders</Link>
        <Link to="/app/suppliers">Suppliers</Link>
        <Link to="/app/locations">Locations</Link>
        <Link to="/app/settings">Settings</Link>
        <Link to="/app/inventory/transfers">Transfers</Link>
        <Link to="/app/inventory/stock-takes">Stock Takes</Link>
        <Link to="/app/inventory/adjustments">Adjustments</Link>
        <Link to="/app/onboarding">Getting started</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
