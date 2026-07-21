import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getVariantsForAssign } from "../services/supplier-assignment.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return json({ suppliers: [], variants: [], total: 0 }, { status: 404 });

  const url = new URL(request.url);
  const search = url.searchParams.get("search") || undefined;
  const unassignedOnly = url.searchParams.get("unassignedOnly") === "1";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);

  const [suppliers, { variants, total }] = await Promise.all([
    prisma.supplier.findMany({
      where: { shopId: shop.id },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    getVariantsForAssign(shop.id, { search, unassignedOnly, limit, offset }),
  ]);

  return json({
    suppliers,
    variants,
    total,
  });
};

export default function AssignDataRoute() {
  return null;
}
