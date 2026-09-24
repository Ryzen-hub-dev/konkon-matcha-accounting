import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import {
  deleteNinjaVanConnection, getNinjaVanConnection, ninjaVanConnectionInputSchema,
  safeNinjaVanConnection, saveNinjaVanConnection,
} from "@/lib/shipping-connections";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  const auth = await authorize("owner.control");
  if (auth.error) return auth.error;
  try { return ok(safeNinjaVanConnection(await getNinjaVanConnection(await getDb()))); }
  catch (error) { return publicError(error); }
}

export async function PATCH(request: Request) {
  const auth = await authorize("owner.control");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = ninjaVanConnectionInputSchema.safeParse(await request.json());
    if (!input.success) return fail("Check the Ninja Van connection settings.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const saved = await saveNinjaVanConnection(db, input.data);
    await writeAudit(db, auth.session, "shipping_connection.configure", "shippingConnection", "NINJA_VAN", {
      environment: saved.environment, countryCode: saved.countryCode, clientIdLast4: saved.clientIdLast4,
    });
    return ok(saved);
  } catch (error) {
    if (error instanceof SyntaxError) return fail("The request body must be valid JSON.", 400);
    if (error instanceof Error && /Ninja Van|Client ID/.test(error.message)) return fail(error.message, 422);
    return publicError(error);
  }
}

export async function DELETE(request: Request) {
  const auth = await authorize("owner.control");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const db = await getDb();
    const deleted = await deleteNinjaVanConnection(db);
    if (deleted) await writeAudit(db, auth.session, "shipping_connection.disconnect", "shippingConnection", "NINJA_VAN");
    return ok(safeNinjaVanConnection());
  } catch (error) { return publicError(error); }
}
