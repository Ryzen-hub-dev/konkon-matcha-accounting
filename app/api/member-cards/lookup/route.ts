import { authorize, fail, ok, sameOrigin } from "@/lib/api";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";
import { memberBindingScanToken, memberScanToken } from "@/lib/scan-codes";
import { memberBindingHash, memberTokenHash } from "@/lib/member-cards";
import { OwnerRecoveryError, readOwnerRecoveryJson } from "@/lib/owner-recovery";

export async function POST(request: Request) {
  const auth = await authorize("members.read");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const body = await readOwnerRecoveryJson(request) as { code?: unknown };
    const raw = typeof body?.code === "string" && body.code.length <= 512 ? body.code : "";
    const token = memberScanToken(raw);
    const binding = memberBindingScanToken(raw);
    if (!token && !binding) return fail("Scan a Kōn-Kōn or bound NFC member card.", 422);
    const db = await getDb();
    const card = await db.collection("memberCards").findOne({ ...(token ? { tokenHash: memberTokenHash(token) } : { bindingHash: memberBindingHash(binding!.source, binding!.fingerprint) }), status: "ACTIVE" });
    const member = card ? await db.collection("members").findOne({ _id: card.memberId, active: { $ne: false } }, { projection: { identityLookupHash: 0, createdBy: 0, archivedBy: 0 } }) : null;
    if (!member) return fail("This card is unavailable, suspended or voided.", 410);
    return ok(serialise({ ...member, scannedCard: { id: card!._id.toHexString(), tier: card!.tier, label: card!.label, kind: card!.kind || "ISSUED", source: card!.bindingSource || null } }));
  } catch (error) { return error instanceof OwnerRecoveryError ? fail(error.message, error.status) : fail("Member card lookup is temporarily unavailable.", 503); }
}
