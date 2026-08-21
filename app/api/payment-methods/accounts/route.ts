import { authorize, ok, publicError } from "@/lib/api";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";

export const runtime = "nodejs";

export async function GET() {
  const auth = await authorize("payments.manage");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const accounts = await db.collection("chartOfAccounts").find({ type: "ASSET", active: { $ne: false } }).project({ code: 1, name: 1, type: 1 }).sort({ code: 1 }).toArray();
    return ok(serialise(accounts));
  } catch (error) { return publicError(error); }
}
