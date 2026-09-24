import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import {
  deleteMyInvoisConnection, getMyInvoisConnection, myInvoisConnectionInputSchema,
  MyInvoisError, safeMyInvoisConnection, saveMyInvoisConnection,
} from "@/lib/myinvois-connection";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  const auth = await authorize("owner.control");
  if (auth.error) return auth.error;
  try { return ok(safeMyInvoisConnection(await getMyInvoisConnection(await getDb()))); }
  catch (error) { return publicError(error); }
}

export async function PATCH(request: Request) {
  const auth = await authorize("owner.control");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = myInvoisConnectionInputSchema.safeParse(await request.json());
    if (!input.success) return fail("Check the MyInvois connection settings.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const saved = await saveMyInvoisConnection(db, input.data);
    await writeAudit(db, auth.session, "tax_connection.configure", "taxConnection", "MYINVOIS", {
      environment: saved.environment, clientIdLast4: saved.clientIdLast4,
    });
    return ok(saved);
  } catch (error) {
    if (error instanceof SyntaxError) return fail("The request body must be valid JSON.", 400);
    if (error instanceof MyInvoisError) return fail(error.message, error.status);
    return publicError(error);
  }
}

export async function DELETE(request: Request) {
  const auth = await authorize("owner.control");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const db = await getDb();
    const deleted = await deleteMyInvoisConnection(db);
    if (deleted) await writeAudit(db, auth.session, "tax_connection.disconnect", "taxConnection", "MYINVOIS");
    return ok(safeMyInvoisConnection());
  } catch (error) { return publicError(error); }
}
