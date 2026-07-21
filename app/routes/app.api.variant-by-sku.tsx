import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const sku = url.searchParams.get("sku")?.trim();

  if (!sku) {
    return json({ variant: null }, { status: 400 });
  }

  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return json({ variant: null }, { status: 404 });

  const variant = await prisma.variant.findFirst({
    where: {
      shopId: shop.id,
      OR: [{ sku: sku }, { id: sku }],
    },
    include: { product: true },
  });

  return json({ variant: variant ? { id: variant.id, sku: variant.sku, productTitle: variant.product.title, variantTitle: variant.title } : null });
};
