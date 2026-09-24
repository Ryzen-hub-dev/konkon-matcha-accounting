import { createHmac } from "node:crypto";
import type { Db } from "mongodb";
import { z } from "zod";
import { decryptMemberToken, encryptMemberToken } from "@/lib/member-cards";

export const NOTIFICATION_PROVIDERS = ["TELEGRAM", "FEISHU", "DISCORD"] as const;
export type NotificationProvider = (typeof NOTIFICATION_PROVIDERS)[number];

const optionalSecret = z.preprocess(
  value => typeof value === "string" && !value.trim() ? undefined : value,
  z.string().trim().min(1).max(500).optional(),
);

export const notificationConnectionInputSchema = z.object({
  provider: z.enum(NOTIFICATION_PROVIDERS),
  endpoint: optionalSecret,
  destination: optionalSecret,
  signingSecret: optionalSecret,
  clearSigningSecret: z.boolean().default(false),
}).strict();

export const notificationConnectionDeleteSchema = z.object({ provider: z.enum(NOTIFICATION_PROVIDERS) }).strict();

type NotificationConnectionRecord = {
  _id: NotificationProvider;
  encryptedEndpoint: string;
  encryptedDestination?: string;
  encryptedSigningSecret?: string;
  endpointLast4: string;
  destinationLast4: string;
  signingSecretLast4: string;
  validatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type ResolvedConnection = { provider: NotificationProvider; endpoint: string; destination: string; signingSecret: string };

function context(provider: NotificationProvider, field: "endpoint" | "destination" | "signing-secret") {
  return `notification:${provider.toLowerCase()}:${field}:v1`;
}

function decryptOptional(value: string | undefined, provider: NotificationProvider, field: "destination" | "signing-secret") {
  return value ? decryptMemberToken(value, context(provider, field)) : "";
}

export function officialNotificationEndpoint(provider: Exclude<NotificationProvider, "TELEGRAM">, value: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${provider === "DISCORD" ? "Discord" : "Feishu"} webhook URL is invalid.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("Use the original HTTPS webhook URL without credentials, query parameters or fragments.");
  }
  const valid = provider === "DISCORD"
    ? url.hostname === "discord.com" && /^\/api\/webhooks\/\d{17,22}\/[A-Za-z0-9._-]{20,200}\/?$/.test(url.pathname)
    : ["open.feishu.cn", "open.larksuite.com"].includes(url.hostname) && /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]{20,100}\/?$/.test(url.pathname);
  if (!valid) throw new Error(`Use an official ${provider === "DISCORD" ? "Discord" : "Feishu/Lark"} incoming webhook URL.`);
  return url.toString().replace(/\/$/, "");
}

export function telegramCredentials(token: string, chatId: string) {
  if (!/^\d{5,20}:[A-Za-z0-9_-]{30,100}$/.test(token)) throw new Error("Telegram Bot token format is invalid.");
  if (!/^(?:-?\d{5,25}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(chatId)) throw new Error("Telegram chat ID or channel username is invalid.");
  return { token, chatId };
}

export function feishuSignature(timestamp: string, secret: string) {
  return createHmac("sha256", `${timestamp}\n${secret}`).digest("base64");
}

function safeMessage(value: string) {
  return value.normalize("NFKC").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim().slice(0, 1_500);
}

async function connectorRequest(url: string, init: RequestInit, provider: NotificationProvider, request: typeof fetch) {
  let response: Response;
  try { response = await request(url, { ...init, signal: AbortSignal.timeout(8_000), cache: "no-store" }); }
  catch { throw new Error(`${provider === "FEISHU" ? "Feishu" : provider[0] + provider.slice(1).toLowerCase()} could not be reached.`); }
  if (response.status === 429) throw new Error(`${provider === "FEISHU" ? "Feishu" : provider[0] + provider.slice(1).toLowerCase()} is rate-limiting messages. Try again later.`);
  if (!response.ok) throw new Error(`${provider === "FEISHU" ? "Feishu" : provider[0] + provider.slice(1).toLowerCase()} rejected the message (${response.status}).`);
  return response;
}

export async function deliverNotification(connection: ResolvedConnection, message: string, request: typeof fetch = fetch) {
  const text = safeMessage(message);
  if (!text) throw new Error("Notification text cannot be empty.");
  if (connection.provider === "TELEGRAM") {
    const { token, chatId } = telegramCredentials(connection.endpoint, connection.destination);
    const response = await connectorRequest(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, protect_content: true }),
    }, connection.provider, request);
    const result = await response.json().catch(() => null) as { ok?: unknown } | null;
    if (result?.ok !== true) throw new Error("Telegram did not confirm the message.");
    return;
  }
  const webhookUrl = officialNotificationEndpoint(connection.provider, connection.endpoint);
  if (connection.provider === "DISCORD") {
    const url = new URL(webhookUrl); url.searchParams.set("wait", "true");
    await connectorRequest(url.toString(), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text, username: "Kōn-Kōn Ledger", allowed_mentions: { parse: [] } }),
    }, connection.provider, request);
    return;
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = {
    ...(connection.signingSecret ? { timestamp, sign: feishuSignature(timestamp, connection.signingSecret) } : {}),
    msg_type: "text", content: { text },
  };
  const response = await connectorRequest(webhookUrl, {
    method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body),
  }, connection.provider, request);
  const result = await response.json().catch(() => null) as { code?: unknown; StatusCode?: unknown } | null;
  if (!result || result.code !== 0 && result.StatusCode !== 0) throw new Error("Feishu did not confirm the message.");
}

export function safeNotificationConnection(record?: Partial<NotificationConnectionRecord> | null, provider?: NotificationProvider) {
  const id = provider || record?._id || "TELEGRAM";
  return {
    provider: id,
    configured: Boolean(record?.encryptedEndpoint),
    endpointLast4: String(record?.endpointLast4 || ""),
    destinationLast4: String(record?.destinationLast4 || ""),
    signingSecretLast4: String(record?.signingSecretLast4 || ""),
    validatedAt: record?.validatedAt || null,
  };
}

export async function getNotificationConnections(db: Db) {
  const records = await db.collection<NotificationConnectionRecord>("notificationConnections").find({ _id: { $in: [...NOTIFICATION_PROVIDERS] } }).toArray();
  return NOTIFICATION_PROVIDERS.map(provider => safeNotificationConnection(records.find(record => record._id === provider), provider));
}

function resolveSaved(record: NotificationConnectionRecord | null, input: z.infer<typeof notificationConnectionInputSchema>): ResolvedConnection {
  const provider = input.provider;
  const endpoint = input.endpoint || (record ? decryptMemberToken(record.encryptedEndpoint, context(provider, "endpoint")) : "");
  const destination = input.destination || (record ? decryptOptional(record.encryptedDestination, provider, "destination") : "");
  const signingSecret = input.clearSigningSecret ? "" : input.signingSecret || (record ? decryptOptional(record.encryptedSigningSecret, provider, "signing-secret") : "");
  if (!endpoint || provider === "TELEGRAM" && !destination) throw new Error(`Enter the ${provider === "TELEGRAM" ? "Bot token and chat ID" : "webhook URL"} for the first connection.`);
  if (provider === "TELEGRAM") telegramCredentials(endpoint, destination);
  else officialNotificationEndpoint(provider, endpoint);
  return { provider, endpoint, destination, signingSecret };
}

export async function saveNotificationConnection(db: Db, input: z.infer<typeof notificationConnectionInputSchema>) {
  const collection = db.collection<NotificationConnectionRecord>("notificationConnections");
  const current = await collection.findOne({ _id: input.provider });
  const resolved = resolveSaved(current, input);
  await deliverNotification(resolved, "Kōn-Kōn Ledger connection verified. Security and operations notices can now be delivered here.");
  const now = new Date();
  const saved: NotificationConnectionRecord = {
    _id: input.provider,
    encryptedEndpoint: encryptMemberToken(resolved.endpoint, context(input.provider, "endpoint")),
    ...(resolved.destination ? { encryptedDestination: encryptMemberToken(resolved.destination, context(input.provider, "destination")) } : {}),
    ...(resolved.signingSecret ? { encryptedSigningSecret: encryptMemberToken(resolved.signingSecret, context(input.provider, "signing-secret")) } : {}),
    endpointLast4: resolved.endpoint.slice(-4), destinationLast4: resolved.destination.slice(-4), signingSecretLast4: resolved.signingSecret.slice(-4),
    validatedAt: now, createdAt: current?.createdAt || now, updatedAt: now,
  };
  await collection.replaceOne({ _id: input.provider }, saved, { upsert: true });
  return safeNotificationConnection(saved);
}

export async function deleteNotificationConnection(db: Db, provider: NotificationProvider) {
  return (await db.collection<NotificationConnectionRecord>("notificationConnections").deleteOne({ _id: provider })).deletedCount > 0;
}

export async function broadcastNotification(db: Db, message: string) {
  const records = await db.collection<NotificationConnectionRecord>("notificationConnections").find({ _id: { $in: [...NOTIFICATION_PROVIDERS] } }).toArray();
  const results = await Promise.all(records.map(async record => {
    try {
      await deliverNotification({
        provider: record._id,
        endpoint: decryptMemberToken(record.encryptedEndpoint, context(record._id, "endpoint")),
        destination: decryptOptional(record.encryptedDestination, record._id, "destination"),
        signingSecret: decryptOptional(record.encryptedSigningSecret, record._id, "signing-secret"),
      }, message);
      return { provider: record._id, delivered: true };
    } catch { return { provider: record._id, delivered: false }; }
  }));
  return results;
}
