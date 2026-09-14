import { timingSafeEqual } from "node:crypto";
import { authorize, fail, ok, publicError, sameOrigin } from "@/lib/api";
import { getDb } from "@/lib/db";
import { maintainData } from "@/lib/maintenance";

export const runtime = "nodejs";
export const maxDuration = 30;

function validCron(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) return false;
  const provided = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export async function GET(request: Request) {
  const cron = validCron(request);
  if (!cron) {
    const auth = await authorize("settings.read");
    if (auth.error) return auth.error;
    if (auth.session.role !== "OWNER") return fail("Only the Owner can inspect data maintenance.", 403);
  }
  try { return ok(await maintainData(await getDb(), !cron || new URL(request.url).searchParams.get("dryRun") === "1")); }
  catch (error) { return publicError(error); }
}

export async function POST(request: Request) {
  const auth = await authorize("settings.write");
  if (auth.error) return auth.error;
  if (auth.session.role !== "OWNER") return fail("Only the Owner can run data maintenance.", 403);
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try { return ok(await maintainData(await getDb(), false)); }
  catch (error) { return publicError(error); }
}
