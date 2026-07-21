/**
 * GraphQL helper with retry/backoff for Shopify API throttling (429).
 */

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;

export type GraphQLClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export async function graphqlWithRetry<T = unknown>(
  client: GraphQLClient,
  query: string,
  options?: { variables?: Record<string, unknown> }
): Promise<{ data: T; extensions?: { cost?: { requestedQueryCost: number; throttleStatus: { currentlyAvailable: number; restoreRate: number } } } }> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await client.graphql(query, options);
    const json = (await response.json()) as {
      data?: T;
      errors?: Array<{ message?: string }>;
      extensions?: { cost?: { requestedQueryCost?: number; throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } };
    };

    const throttle = json?.extensions?.cost?.throttleStatus;
    const isThrottled =
      response.status === 429 ||
      (throttle && (throttle.currentlyAvailable ?? 1) <= 0);

    if (isThrottled) {
      const cost = json?.extensions?.cost;
      const waitMs = throttle?.restoreRate
        ? Math.ceil(((cost?.requestedQueryCost ?? 1000) - (throttle.currentlyAvailable ?? 0)) / throttle.restoreRate) * 1000
        : INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      await sleep(Math.min(Math.max(waitMs, 500), 10000));
      continue;
    }

    if (json?.errors?.length) {
      const msg = json.errors.map((e) => e.message).join("; ");
      throw new Error(`GraphQL error: ${msg}`);
    }

    if (json.data) return json as { data: T; extensions?: unknown };
  }
  throw new Error("Max retries exceeded for GraphQL request");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
