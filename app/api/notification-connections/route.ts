import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import {
  deleteNotificationConnection, getNotificationConnections, notificationConnectionDeleteSchema,
  notificationConnectionInputSchema, saveNotificationConnection,
} from "@/lib/notification-connectors";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  const auth = await authorize("owner.control");
  if (auth.error) return auth.error;
  try { return ok(await getNotificationConnections(await getDb())); }
  catch (error) { return publicError(error); }
}

export async function PATCH(request: Request) {
  const auth = await authorize("owner.control");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = notificationConnectionInputSchema.safeParse(await request.json());
    if (!input.success) return fail("Check the notification connection details.", 422, input.error.flatten().fieldErrors);
    const db = await getDb();
    const saved = await saveNotificationConnection(db, input.data);
    await writeAudit(db, auth.session, "notification_connection.configure", "notificationConnection", input.data.provider, {
      endpointLast4: saved.endpointLast4, destinationLast4: saved.destinationLast4,
    });
    return ok(saved);
  } catch (error) {
    if (error instanceof SyntaxError) return fail("The request body must be valid JSON.", 400);
    if (error instanceof Error && /Telegram|Discord|Feishu|webhook|connection/.test(error.message)) return fail(error.message, 422);
    return publicError(error);
  }
}

export async function DELETE(request: Request) {
  const auth = await authorize("owner.control");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = notificationConnectionDeleteSchema.safeParse(await request.json());
    if (!input.success) return fail("Choose a notification connection.", 422);
    const db = await getDb();
    const deleted = await deleteNotificationConnection(db, input.data.provider);
    if (deleted) await writeAudit(db, auth.session, "notification_connection.disconnect", "notificationConnection", input.data.provider);
    return ok({ provider: input.data.provider, configured: false });
  } catch (error) { return publicError(error); }
}
