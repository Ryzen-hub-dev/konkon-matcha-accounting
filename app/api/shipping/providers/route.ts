import { authorize, ok, publicError } from "@/lib/api";
import { SHIPPING_PROVIDERS } from "@/lib/shipping-providers";

export async function GET() {
  const auth = await authorize("invoices.read");
  if (auth.error) return auth.error;
  try { return ok(SHIPPING_PROVIDERS); }
  catch (error) { return publicError(error); }
}
