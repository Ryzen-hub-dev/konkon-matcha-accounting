import { fail, ok, publicError } from "@/lib/api";
import { getDb } from "@/lib/db";
import { processTelegramWebhook, TelegramWebhookError } from "@/lib/notification-connectors";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 65_536) return fail("Telegram update is too large.", 413);
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > 65_536) return fail("Telegram update is too large.", 413);
    const body = JSON.parse(raw) as unknown;
    const result = await processTelegramWebhook(
      await getDb(),
      body,
      request.headers.get("x-telegram-bot-api-secret-token") || "",
    );
    return ok(result);
  } catch (error) {
    if (error instanceof SyntaxError) return fail("The request body must be valid JSON.", 400);
    if (error instanceof TelegramWebhookError) return fail(error.message, error.status);
    return publicError(error);
  }
}
