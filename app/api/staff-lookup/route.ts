import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { getDb } from "@/lib/db";
import { staffSelectionTokenHash } from "@/lib/staff-credentials";
import { staffScanToken } from "@/lib/scan-codes";
import { serialise } from "@/lib/format";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await authorize("team.read");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const body = await request.json() as { code?: unknown };
    const token = staffScanToken(String(body.code || ""));
    if (!token) return fail("This is not a staff lookup credential.", 422);
    const user = await (await getDb()).collection("users").findOne(
      { selectionTokenHash: staffSelectionTokenHash(token), active: true, archivedAt: { $exists: false } },
      { projection: { fullName: 1, username: 1, email: 1, role: 1, active: 1 } },
    );
    if (!user) return fail("This staff lookup credential is no longer active.", 404);
    return ok(serialise(user));
  } catch (error) { return publicError(error); }
}
