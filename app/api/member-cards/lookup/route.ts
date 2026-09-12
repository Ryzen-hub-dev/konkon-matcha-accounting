import { authorize, fail, ok, sameOrigin } from "@/lib/api";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { memberScanToken } from "@/lib/scan-codes";
import { memberTokenHash } from "@/lib/member-cards";
import { OwnerRecoveryError, readOwnerRecoveryJson } from "@/lib/owner-recovery";

export async function POST(request: Request) {
  const auth = await authorize("members.read");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const body = await readOwnerRecoveryJson(request) as { code?: unknown };
    const token = typeof body?.code === "string" && body.code.length <= 512 ? memberScanToken(body.code) : "";
    if (!token) return fail("Scan a Kōn-Kōn member card.", 422);
    const db = await getDb();
    const card = await db.collection("memberCards").findOne({ tokenHash: memberTokenHash(token), status: "ACTIVE" });
    const member = card ? await db.collection("members").findOne({ _id: card.memberId, active: { $ne: false } }, { projection: { identityLookupHash: 0, createdBy: 0, archivedBy: 0 } }) : null;
    if (!member) return fail("This card is unavailable, suspended or voided.", 410);
    return ok(serialise({ ...member, scannedCard: { id: card!._id.toHexString(), tier: card!.tier, label: card!.label } }));
  } catch (error) { return error instanceof OwnerRecoveryError ? fail(error.message, error.status) : fail("Member card lookup is temporarily unavailable.", 503); }
}
