import type { Db } from "mongodb";
import { z } from "zod";
import { decryptMemberToken, encryptMemberToken } from "@/lib/member-cards";

const CONNECTION_ID = "NINJA_VAN";
const CLIENT_ID_CONTEXT = "shipping:ninja-van:client-id:v1";
const CLIENT_SECRET_CONTEXT = "shipping:ninja-van:client-secret:v1";
const ACCESS_TOKEN_CONTEXT = "shipping:ninja-van:access-token:v1";
export const NINJA_VAN_COUNTRIES = ["SG", "MY", "TH", "ID", "VN", "PH", "MM"] as const;

const optionalCredential = z.preprocess(
  value => typeof value === "string" && !value.trim() ? undefined : value,
  z.string().trim().min(1).max(300).optional(),
);

export const ninjaVanConnectionInputSchema = z.object({
  environment: z.enum(["SANDBOX", "PRODUCTION"]),
  countryCode: z.enum(NINJA_VAN_COUNTRIES),
  clientId: optionalCredential,
  clientSecret: optionalCredential,
}).strict();

export type NinjaVanConnectionRecord = {
  _id: typeof CONNECTION_ID;
  environment: "SANDBOX" | "PRODUCTION";
  countryCode: (typeof NINJA_VAN_COUNTRIES)[number];
  encryptedClientId: string;
  encryptedClientSecret: string;
  clientIdLast4: string;
  secretLast4: string;
  encryptedAccessToken?: string;
  accessTokenExpiresAt?: Date;
  accessTokenRefreshedAt?: Date;
  validatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export function ninjaVanOAuthUrl(environment: "SANDBOX" | "PRODUCTION", countryCode: (typeof NINJA_VAN_COUNTRIES)[number]) {
  const host = environment === "SANDBOX" ? "https://api-sandbox.ninjavan.co" : "https://api.ninjavan.co";
  const requestCountry = environment === "SANDBOX" ? "sg" : countryCode.toLowerCase();
  return `${host}/${requestCountry}/2.0/oauth/access_token`;
}

export function ninjaVanApiBase(environment: NinjaVanConnectionRecord["environment"], countryCode: NinjaVanConnectionRecord["countryCode"]) {
  const host = environment === "SANDBOX" ? "https://api-sandbox.ninjavan.co" : "https://api.ninjavan.co";
  return `${host}/${environment === "SANDBOX" ? "sg" : countryCode.toLowerCase()}`;
}

export function safeNinjaVanConnection(record?: Partial<NinjaVanConnectionRecord> | null) {
  return record?.encryptedClientSecret ? {
    configured: true,
    provider: CONNECTION_ID,
    environment: record.environment || "SANDBOX",
    countryCode: record.countryCode || "SG",
    clientIdLast4: String(record.clientIdLast4 || ""),
    secretLast4: String(record.secretLast4 || ""),
    validatedAt: record.validatedAt || null,
  } : {
    configured: false,
    provider: CONNECTION_ID,
    environment: "SANDBOX" as const,
    countryCode: "SG" as const,
    clientIdLast4: "",
    secretLast4: "",
    validatedAt: null,
  };
}

export async function getNinjaVanConnection(db: Db) {
  return await db.collection<NinjaVanConnectionRecord>("shippingConnections").findOne({ _id: CONNECTION_ID });
}

export async function validateNinjaVanCredentials(
  input: { environment: NinjaVanConnectionRecord["environment"]; countryCode: NinjaVanConnectionRecord["countryCode"]; clientId: string; clientSecret: string },
  request: typeof fetch = fetch,
) {
  let response: Response;
  try {
    response = await request(ninjaVanOAuthUrl(input.environment, input.countryCode), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: input.clientId, client_secret: input.clientSecret, grant_type: "client_credentials" }),
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
  } catch {
    throw new Error("Ninja Van could not be reached. Check the network and try again.");
  }
  if ([400, 401, 403].includes(response.status)) throw new Error("Ninja Van rejected these credentials or this environment.");
  if (response.status === 429) throw new Error("Ninja Van is rate-limiting connection checks. Try again later.");
  if (!response.ok) throw new Error(`Ninja Van connection check failed (${response.status}).`);
  const result = await response.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown } | null;
  if (!result || typeof result.access_token !== "string" || !result.access_token) throw new Error("Ninja Van did not return a valid access token.");
  return { expiresIn: typeof result.expires_in === "number" ? result.expires_in : null };
}

async function requestNinjaVanAccessToken(record: NinjaVanConnectionRecord, request: typeof fetch) {
  const clientId = decryptMemberToken(record.encryptedClientId, CLIENT_ID_CONTEXT);
  const clientSecret = decryptMemberToken(record.encryptedClientSecret, CLIENT_SECRET_CONTEXT);
  let response: Response;
  try {
    response = await request(ninjaVanOAuthUrl(record.environment, record.countryCode), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
  } catch {
    throw new Error("Ninja Van could not be reached. Check the network and try again.");
  }
  if ([400, 401, 403].includes(response.status)) throw new Error("Ninja Van rejected the saved credentials or environment.");
  if (response.status === 429) throw new Error("Ninja Van is rate-limiting requests. Try again later.");
  if (!response.ok) throw new Error(`Ninja Van authentication failed (${response.status}).`);
  const result = await response.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown } | null;
  if (!result || typeof result.access_token !== "string" || !result.access_token) throw new Error("Ninja Van did not return a valid access token.");
  const expiresIn = typeof result.expires_in === "number" && Number.isFinite(result.expires_in)
    ? Math.max(60, Math.min(result.expires_in, 86_400))
    : 3_600;
  return { token: result.access_token, expiresAt: new Date(Date.now() + expiresIn * 1_000) };
}

export async function getNinjaVanAccessToken(db: Db, record: NinjaVanConnectionRecord, request: typeof fetch = fetch, forceRefresh = false) {
  const expiresAt = record.accessTokenExpiresAt ? new Date(record.accessTokenExpiresAt) : null;
  if (!forceRefresh && record.encryptedAccessToken && expiresAt && expiresAt.getTime() > Date.now() + 5 * 60_000) {
    return decryptMemberToken(record.encryptedAccessToken, ACCESS_TOKEN_CONTEXT);
  }
  const issued = await requestNinjaVanAccessToken(record, request);
  await db.collection<NinjaVanConnectionRecord>("shippingConnections").updateOne(
    { _id: CONNECTION_ID },
    { $set: {
      encryptedAccessToken: encryptMemberToken(issued.token, ACCESS_TOKEN_CONTEXT),
      accessTokenExpiresAt: issued.expiresAt,
      accessTokenRefreshedAt: new Date(),
    } },
  );
  return issued.token;
}

export function decryptNinjaVanClientSecret(record: NinjaVanConnectionRecord) {
  return decryptMemberToken(record.encryptedClientSecret, CLIENT_SECRET_CONTEXT);
}

export async function saveNinjaVanConnection(db: Db, input: z.infer<typeof ninjaVanConnectionInputSchema>) {
  const current = await getNinjaVanConnection(db);
  const clientId = input.clientId || (current ? decryptMemberToken(current.encryptedClientId, CLIENT_ID_CONTEXT) : "");
  const clientSecret = input.clientSecret || (current ? decryptMemberToken(current.encryptedClientSecret, CLIENT_SECRET_CONTEXT) : "");
  if (!clientId || !clientSecret) throw new Error("Enter the Ninja Van Client ID and Client Key for the first connection.");
  await validateNinjaVanCredentials({ ...input, clientId, clientSecret });
  const now = new Date();
  const saved: NinjaVanConnectionRecord = {
    _id: CONNECTION_ID,
    environment: input.environment,
    countryCode: input.countryCode,
    encryptedClientId: encryptMemberToken(clientId, CLIENT_ID_CONTEXT),
    encryptedClientSecret: encryptMemberToken(clientSecret, CLIENT_SECRET_CONTEXT),
    clientIdLast4: clientId.slice(-4),
    secretLast4: clientSecret.slice(-4),
    validatedAt: now,
    createdAt: current?.createdAt || now,
    updatedAt: now,
  };
  await db.collection<NinjaVanConnectionRecord>("shippingConnections").replaceOne({ _id: CONNECTION_ID }, saved, { upsert: true });
  return safeNinjaVanConnection(saved);
}

export async function deleteNinjaVanConnection(db: Db) {
  return (await db.collection<NinjaVanConnectionRecord>("shippingConnections").deleteOne({ _id: CONNECTION_ID })).deletedCount > 0;
}
