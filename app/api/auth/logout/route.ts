import { clearSession, readSession } from "@/lib/auth";
import { fail, ok, sameOrigin } from "@/lib/api";
import { getDb } from "@/lib/db";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  const session = await readSession();
  await clearSession();
  if (session) {
    try {
      const db = await getDb();
      await db.collection("auditLogs").insertOne({
        actorId: session.id,
        actorName: session.fullName,
        actorRole: session.role,
        action: "auth.logout",
        entityType: "user",
        entityId: session.id,
        details: {},
        createdAt: new Date(),
      });
    } catch { /* logout must still succeed if audit storage is unavailable */ }
  }
  return ok({ redirectTo: "/login" });
}
