import { authorize, fail, ok, sameOrigin } from "@/lib/api";
import { resolveTrackingLinks, trackingLinkRequestSchema } from "@/lib/shipping-providers";

export async function POST(request: Request) {
  const auth = await authorize("invoices.read");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = trackingLinkRequestSchema.safeParse(await request.json());
    if (!input.success) return fail("Check the carrier and tracking references.", 422, input.error.flatten().fieldErrors);
    return ok(resolveTrackingLinks(input.data));
  } catch (error) {
    if (error instanceof SyntaxError) return fail("The request body must be valid JSON.", 400);
    if (error instanceof Error) return fail(error.message, 422);
    return fail("The tracking link could not be prepared.", 500);
  }
}
