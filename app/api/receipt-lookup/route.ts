import { ObjectId } from "mongodb";
import { authorize, fail, ok, sameOrigin } from "@/lib/api";
import { getDb } from "@/lib/db";
import { receiptScanToken, receiptTokenId } from "@/lib/scan-codes";
import { validReceiptAccess } from "@/lib/receipt-access";
import { OwnerRecoveryError, readOwnerRecoveryJson } from "@/lib/owner-recovery";

export async function POST(request: Request) {
  const auth = await authorize("receipts.read");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = await readOwnerRecoveryJson(request) as { code?: unknown };
    const code = typeof input?.code === "string" ? input.code.trim() : "";
    if (!code || code.length > 512) return fail("Scan a receipt QR or enter its receipt number.", 422);
    const token = receiptScanToken(code);
    const db = await getDb();
    const sale = await db.collection("sales").findOne(token ? { _id: new ObjectId(receiptTokenId(token)) } : { receiptNo: code.toUpperCase() });
    if (!sale || (token && !validReceiptAccess(sale, token))) return fail("No matching receipt was found.", 404);
    return ok({ id: sale._id.toHexString(), receiptNo: sale.receiptNo });
  } catch (error) {
    if (error instanceof OwnerRecoveryError) return fail(error.message, error.status);
    return fail("The receipt could not be looked up.", 503);
  }
}
