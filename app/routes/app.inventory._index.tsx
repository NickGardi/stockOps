import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/** /app/inventory is reserved as a layout for transfers/takes/adjustments.
 *  The inventory browser lives at /app/stock so NavMenu can show it
 *  (App Bridge hides parent links that are path prefixes of other nav items). */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return redirect("/app/stock");
};
