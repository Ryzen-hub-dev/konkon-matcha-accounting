import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  deliverNotification, feishuSignature, officialNotificationEndpoint, telegramCredentials,
} from "../lib/notification-connectors";

test("notification endpoints accept only exact official webhook hosts and paths", () => {
  const discord = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDE";
  const feishu = "https://open.feishu.cn/open-apis/bot/v2/hook/12345678-1234-1234-1234-123456789012";
  assert.equal(officialNotificationEndpoint("DISCORD", discord), discord);
  assert.equal(officialNotificationEndpoint("FEISHU", feishu), feishu);
  for (const unsafe of [
    "http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDE",
    "https://discord.com.evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDE",
    "https://open.feishu.cn@127.0.0.1/open-apis/bot/v2/hook/12345678-1234-1234-1234-123456789012",
    "https://open.feishu.cn/open-apis/bot/v2/hook/12345678-1234-1234-1234-123456789012?next=http://127.0.0.1",
  ]) assert.throws(() => unsafe.includes("discord") ? officialNotificationEndpoint("DISCORD", unsafe) : officialNotificationEndpoint("FEISHU", unsafe));
});

test("Telegram delivery uses the documented JSON request without parse mode", async () => {
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input); capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  };
  await deliverNotification({ provider: "TELEGRAM", endpoint: "123456789:abcdefghijklmnopqrstuvwxyzABCDE_12345", destination: "-1001234567890", signingSecret: "" }, "Ledger safe", request as typeof fetch);
  assert.equal(capturedUrl, "https://api.telegram.org/bot123456789:abcdefghijklmnopqrstuvwxyzABCDE_12345/sendMessage");
  assert.deepEqual(capturedBody, { chat_id: "-1001234567890", text: "Ledger safe", protect_content: true });
  assert.deepEqual(telegramCredentials("123456789:abcdefghijklmnopqrstuvwxyzABCDE_12345", "@matcha_ops"), { token: "123456789:abcdefghijklmnopqrstuvwxyzABCDE_12345", chatId: "@matcha_ops" });
});

test("Discord delivery disables mentions and Feishu signing matches its documented HMAC shape", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return calls.length === 1 ? new Response(JSON.stringify({ id: "1" }), { status: 200 }) : new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 });
  };
  await deliverNotification({ provider: "DISCORD", endpoint: "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDE", destination: "", signingSecret: "" }, "No @everyone", request as typeof fetch);
  await deliverNotification({ provider: "FEISHU", endpoint: "https://open.feishu.cn/open-apis/bot/v2/hook/12345678-1234-1234-1234-123456789012", destination: "", signingSecret: "secret" }, "Mode closed", request as typeof fetch);
  assert.match(calls[0].url, /\?wait=true$/);
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
  const timestamp = String(calls[1].body.timestamp);
  assert.equal(calls[1].body.sign, createHmac("sha256", `${timestamp}\nsecret`).digest("base64"));
  assert.equal(feishuSignature(timestamp, "secret"), calls[1].body.sign);
});
