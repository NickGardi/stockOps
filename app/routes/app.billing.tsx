import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigate, useNavigation, useSearchParams } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  List,
  Text,
} from "@shopify/polaris";
import { PageShell } from "../components/PageShell";
import {
  authenticate,
  billingIsTest,
  isDevelopmentStore,
  MONTHLY_PLAN,
} from "../shopify.server";

type ShopifySubscriptionDetails = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  currentPeriodEnd: string | null;
  trialDays: number;
  test: boolean;
};

function addDays(iso: string, days: number): Date {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function formatBillingDate(isoOrDate: string | Date): string {
  const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

async function fetchActiveSubscriptionDetails(admin: {
  graphql: (query: string) => Promise<Response>;
}): Promise<ShopifySubscriptionDetails | null> {
  const response = await admin.graphql(
    `#graphql
    query ActiveAppSubscription {
      currentAppInstallation {
        activeSubscriptions {
          id
          name
          status
          createdAt
          currentPeriodEnd
          trialDays
          test
        }
      }
    }`
  );
  const body = (await response.json()) as {
    data?: {
      currentAppInstallation?: {
        activeSubscriptions?: ShopifySubscriptionDetails[];
      };
    };
  };
  return body.data?.currentAppInstallation?.activeSubscriptions?.[0] ?? null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, admin } = await authenticate.admin(request);
  const isTest = billingIsTest() || (await isDevelopmentStore(admin));

  const { hasActivePayment } = await billing.check({
    plans: [MONTHLY_PLAN],
    isTest,
  });

  const details = hasActivePayment
    ? await fetchActiveSubscriptionDetails(admin)
    : null;

  let subscription: {
    id: string;
    name: string;
    status: string;
    onTrial: boolean;
    trialEndsOn: string | null;
    renewsOn: string | null;
    nextChargeOn: string | null;
  } | null = null;

  if (details) {
    const trialEnd =
      details.trialDays > 0 ? addDays(details.createdAt, details.trialDays) : null;
    const now = new Date();
    const onTrial = Boolean(trialEnd && trialEnd.getTime() > now.getTime());
    const renewsOn = details.currentPeriodEnd;
    // While on trial, first charge is at trial end; after that, currentPeriodEnd.
    const nextChargeOn = onTrial
      ? trialEnd!.toISOString()
      : renewsOn;

    subscription = {
      id: details.id,
      name: details.name,
      status: details.status,
      onTrial,
      trialEndsOn: trialEnd ? trialEnd.toISOString() : null,
      renewsOn,
      nextChargeOn,
    };
  }

  return json({
    planName: MONTHLY_PLAN,
    price: 10,
    currency: "USD",
    trialDays: 30,
    hasActivePayment,
    isTest,
    subscription,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing, session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const isTest = billingIsTest() || (await isDevelopmentStore(admin));

  if (intent === "subscribe") {
    // Throws a redirect to Shopify's charge approval page (must be a document Form post)
    return billing.request({
      plan: MONTHLY_PLAN,
      isTest,
      returnUrl: `https://${session.shop}/admin/apps/${process.env.SHOPIFY_API_KEY}/app/billing?subscribed=1`,
    });
  }

  if (intent === "cancel") {
    const subscriptionId = String(formData.get("subscriptionId") || "").trim();
    if (!subscriptionId) {
      return json({ error: "No subscription to cancel" }, { status: 400 });
    }
    await billing.cancel({
      subscriptionId,
      isTest,
      prorate: true,
    });
    return json({ ok: true, cancelled: true });
  }

  return json({ error: "Invalid intent" }, { status: 400 });
};

export default function BillingPage() {
  const navigate = useNavigate();
  const {
    planName,
    price,
    currency,
    trialDays,
    hasActivePayment,
    isTest,
    subscription,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string; cancelled?: boolean }>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const justSubscribed = searchParams.get("subscribed") === "1";
  const isBusy = navigation.state !== "idle";

  return (
    <PageShell
      title="Billing"
      backAction={{ onAction: () => navigate("/app/settings") }}
    >
      <BlockStack gap="400">
        {justSubscribed && hasActivePayment && (
          <Banner tone="success" title="You're subscribed">
            <p>
              Thanks — your StockOps plan is active
              {subscription?.onTrial ? " on a free trial" : ""}
              {isTest ? " (test charge)" : ""}.
              {subscription?.onTrial && subscription.trialEndsOn
                ? ` Trial ends ${formatBillingDate(subscription.trialEndsOn)}.`
                : subscription?.renewsOn
                  ? ` Renews ${formatBillingDate(subscription.renewsOn)}.`
                  : ""}
            </p>
          </Banner>
        )}
        {actionData?.cancelled && (
          <Banner tone="success" title="Subscription cancelled">
            <p>Your plan has been cancelled. You can subscribe again anytime.</p>
          </Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical">
            <p>{actionData.error}</p>
          </Banner>
        )}
        {isTest && (
          <Banner tone="info" title="Test billing mode">
            <p>
              Charges are test-only for this store (development stores are never billed for real).
              Paid Shopify stores are charged normally.
            </p>
          </Banner>
        )}

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="start">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  {planName}
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Inventory reorder, purchase orders, receiving, and transfers — synced with Shopify.
                </Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text as="p" variant="headingLg">
                  ${price}
                  <Text as="span" variant="bodyMd" tone="subdued">
                    {" "}
                    / month
                  </Text>
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {currency} · billed every 30 days
                </Text>
              </BlockStack>
            </InlineStack>

            <List type="bullet">
              <List.Item>{trialDays}-day free trial — no charge until the trial ends</List.Item>
              <List.Item>Cancel anytime from this page or Shopify Admin → Settings → Apps</List.Item>
              <List.Item>Billed through Shopify (appears on the merchant&apos;s Shopify invoice)</List.Item>
            </List>

            {hasActivePayment && subscription ? (
              <BlockStack gap="300">
                <Banner
                  tone={subscription.onTrial ? "info" : "success"}
                  title={
                    subscription.onTrial
                      ? "Free trial active"
                      : "Active subscription"
                  }
                >
                  <BlockStack gap="100">
                    <p>
                      Status: <strong>{subscription.status}</strong>
                      {subscription.name ? ` · ${subscription.name}` : ""}
                    </p>
                    {subscription.onTrial && subscription.trialEndsOn ? (
                      <p>
                        Trial ends on{" "}
                        <strong>{formatBillingDate(subscription.trialEndsOn)}</strong>
                        {subscription.nextChargeOn
                          ? ` — first charge on ${formatBillingDate(subscription.nextChargeOn)}`
                          : ""}
                        .
                      </p>
                    ) : subscription.renewsOn ? (
                      <p>
                        Renews on{" "}
                        <strong>{formatBillingDate(subscription.renewsOn)}</strong>.
                      </p>
                    ) : subscription.nextChargeOn ? (
                      <p>
                        Next charge on{" "}
                        <strong>{formatBillingDate(subscription.nextChargeOn)}</strong>.
                      </p>
                    ) : null}
                  </BlockStack>
                </Banner>
                <Form method="post">
                  <input type="hidden" name="intent" value="cancel" />
                  <input type="hidden" name="subscriptionId" value={subscription.id} />
                  <Button tone="critical" submit loading={isBusy} disabled={isBusy}>
                    Cancel subscription
                  </Button>
                </Form>
              </BlockStack>
            ) : (
              <Form method="post">
                <input type="hidden" name="intent" value="subscribe" />
                <Button variant="primary" submit loading={isBusy} disabled={isBusy}>
                  Start {trialDays}-day free trial
                </Button>
              </Form>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </PageShell>
  );
}
