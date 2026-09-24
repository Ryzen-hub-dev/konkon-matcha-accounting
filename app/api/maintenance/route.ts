import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { validCronRequest } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";
import { maintainData } from "@/lib/maintenance";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request) {
  const cron = validCronRequest(request);
  if (!cron) {
    const auth = await authorize("owner.control");
    if (auth.error) return auth.error;
  }
  try { return ok(await maintainData(await getDb(), !cron || new URL(request.url).searchParams.get("dryRun") === "1")); }
  catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("owner.control");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try { return ok(await maintainData(await getDb(), false)); }
  catch (error) { return publicError(error); }
}
