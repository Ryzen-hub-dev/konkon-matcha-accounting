import { authorize, ok, publicError } from "@/lib/api";
import { getDb } from "@/lib/db";
import { serialise } from "@/lib/format";

export const runtime = "nodejs";

export async function GET() {
  const auth = await authorize("settings.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    const history = await db.collection("settingsHistory").find({ key: "business" }).sort({ createdAt: -1 }).limit(100).toArray();
    const response = ok(serialise(history));
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch (error) {
    return publicError(error);
  }
}
