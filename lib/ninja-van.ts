import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "mongodb";
import { z } from "zod";
import {
  decryptNinjaVanClientSecret,
  getNinjaVanAccessToken,
  getNinjaVanConnection,
  ninjaVanApiBase,
  type NinjaVanConnectionRecord,
} from "@/lib/shipping-connections";

const addressSchema = z.object({
  address1: z.string().trim().min(3).max(120),
  address2: z.string().trim().max(120).default(""),
  area: z.string().trim().max(80).default(""),
  city: z.string().trim().max(80).default(""),
  state: z.string().trim().max(80).default(""),
  country: z.string().trim().regex(/^[A-Z]{2}$/),
  postcode: z.string().trim().min(2).max(20),
});

export const ninjaVanBookOrderSchema = z.object({
  id: z.string().regex(/^[a-fA-F0-9]{24}$/).transform(value => value.toLowerCase()),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
}).strict();

const orderSchema = z.object({
  deliveryOrderNo: z.string().trim().min(1).max(80),
  contactName: z.string().trim().min(2).max(120),
  contactPhone: z.string().trim().min(6).max(40),
  contactEmail: z.union([z.literal(""), z.string().trim().email().max(160)]).default(""),
  deliveryAddress1: z.string(),
  deliveryAddress2: z.string().default(""),
  deliveryArea: z.string().default(""),
  deliveryCity: z.string().default(""),
  deliveryState: z.string().default(""),
  deliveryCountryCode: z.string(),
  deliveryPostcode: z.string(),
  serviceLevel: z.enum(["Standard", "Express", "Sameday", "Nextday"]).default("Standard"),
  pickupRequired: z.boolean().default(true),
  parcelWeight: z.number().finite().positive().max(1_000),
  scheduledDate: z.union([z.date(), z.string()]),
  instructions: z.string().trim().max(500).default(""),
  items: z.array(z.object({
    description: z.string().trim().min(1).max(255),
    quantity: z.number().int().positive().max(100_000),
  })).min(1).max(200),
});

export const ninjaVanWebhookSchema = z.object({
  tracking_id: z.string().trim().min(3).max(120),
  shipper_order_ref_no: z.string().trim().max(120).optional().default(""),
  timestamp: z.string().trim().min(10).max(50),
  event: z.string().trim().max(160).optional(),
  status: z.string().trim().min(1).max(160),
  is_parcel_on_rts_leg: z.boolean().optional(),
}).passthrough();

export type NinjaVanWebhook = z.infer<typeof ninjaVanWebhookSchema>;

export class NinjaVanError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

export function ninjaVanRequestedTrackingNumber(deliveryOrderNo: string) {
  const cleaned = deliveryOrderNo.toUpperCase().replace(/[^A-Z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return (cleaned.length >= 9 ? cleaned : `ORDER-${cleaned}`).slice(0, 80).replace(/-$/g, "0");
}

export function buildNinjaVanOrderPayload(orderValue: unknown, connection: Pick<NinjaVanConnectionRecord, "countryCode">) {
  const parsed = orderSchema.safeParse(orderValue);
  if (!parsed.success) throw new NinjaVanError("Complete the Ninja Van recipient, address, parcel weight and shipment details before booking.");
  const order = parsed.data;
  if (order.deliveryCountryCode !== connection.countryCode) {
    throw new NinjaVanError(`This Ninja Van connection accepts domestic ${connection.countryCode} orders. Change the recipient country or connection country.`);
  }
  const address = addressSchema.parse({
    address1: order.deliveryAddress1,
    address2: order.deliveryAddress2,
    area: order.deliveryArea,
    city: order.deliveryCity,
    state: order.deliveryState,
    country: order.deliveryCountryCode,
    postcode: order.deliveryPostcode,
  });
  return {
    service_type: "Parcel",
    service_level: order.serviceLevel,
    requested_tracking_number: ninjaVanRequestedTrackingNumber(order.deliveryOrderNo),
    reference: { merchant_order_number: order.deliveryOrderNo },
    to: {
      name: order.contactName,
      phone_number: order.contactPhone,
      ...(order.contactEmail ? { email: order.contactEmail } : {}),
      address,
    },
    parcel_job: {
      is_pickup_required: order.pickupRequired,
      delivery_start_date: new Date(order.scheduledDate).toISOString().slice(0, 10),
      ...(order.instructions ? { delivery_instructions: order.instructions } : {}),
      dimensions: { weight: order.parcelWeight },
      items: order.items.map(item => ({ item_description: item.description, quantity: item.quantity, is_dangerous_good: false })),
    },
  };
}

function safeProviderError(status: number) {
  if (status === 400) return "Ninja Van rejected the shipment details. Review the address, phone, service and parcel data.";
  if (status === 401) return "Ninja Van authentication expired and could not be refreshed.";
  if (status === 403) return "Ninja Van has not enabled this API or environment for the connected account.";
  if (status === 404) return "Ninja Van could not find the requested shipment.";
  if (status === 409) return "Ninja Van reports that this shipment already exists.";
  if (status === 429) return "Ninja Van is rate-limiting requests. Try again later.";
  if (status >= 500) return "Ninja Van is temporarily unavailable. The stable shipment reference makes a retry safe.";
  return `Ninja Van could not complete the request (${status}).`;
}

async function ninjaVanFetch(
  db: Db,
  connection: NinjaVanConnectionRecord,
  path: string,
  init: RequestInit,
  request: typeof fetch,
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getNinjaVanAccessToken(db, connection, request, attempt > 0);
    let response: Response;
    try {
      response = await request(`${ninjaVanApiBase(connection.environment, connection.countryCode)}${path}`, {
        ...init,
        headers: { Accept: "application/json", ...init.headers, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      });
    } catch {
      if (attempt === 0 && init.method === "POST") continue;
      throw new NinjaVanError("Ninja Van could not be reached. The shipment reference is stable; retry after checking the network.", 503);
    }
    if (response.status === 401 && attempt === 0) continue;
    if (response.status >= 500 && attempt === 0 && init.method === "POST") continue;
    return response;
  }
  throw new NinjaVanError("Ninja Van could not complete the request.", 503);
}

export async function createNinjaVanOrder(db: Db, order: unknown, request: typeof fetch = fetch) {
  const connection = await getNinjaVanConnection(db);
  if (!connection) throw new NinjaVanError("Connect and verify Ninja Van in Settings before booking a shipment.");
  const payload = buildNinjaVanOrderPayload(order, connection);
  const response = await ninjaVanFetch(db, connection, "/4.2/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, request);
  if (!response.ok) throw new NinjaVanError(safeProviderError(response.status), response.status >= 500 ? 503 : 422);
  const result = await response.json().catch(() => null) as { tracking_number?: unknown; requested_tracking_number?: unknown } | null;
  if (!result || typeof result.tracking_number !== "string" || !result.tracking_number.trim()) {
    throw new NinjaVanError("Ninja Van accepted the request but did not return a tracking number.", 502);
  }
  return {
    trackingNumber: result.tracking_number.trim(),
    requestedTrackingNumber: typeof result.requested_tracking_number === "string"
      ? result.requested_tracking_number
      : payload.requested_tracking_number,
    environment: connection.environment,
    countryCode: connection.countryCode,
  };
}

export async function getNinjaVanWaybill(db: Db, trackingNumber: string, request: typeof fetch = fetch) {
  const connection = await getNinjaVanConnection(db);
  if (!connection) throw new NinjaVanError("The Ninja Van connection is not configured.");
  const response = await ninjaVanFetch(
    db,
    connection,
    `/2.0/reports/waybill?tid=${encodeURIComponent(trackingNumber)}&hide_shipper_details=0`,
    { method: "GET", headers: { Accept: "application/pdf" } },
    request,
  );
  if (!response.ok) throw new NinjaVanError(safeProviderError(response.status), response.status >= 500 ? 503 : 422);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 3_500_000) throw new NinjaVanError("The waybill is empty or too large for this Vercel deployment.", 502);
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new NinjaVanError("Ninja Van did not return a PDF waybill.", 502);
  return bytes;
}

export function verifyNinjaVanWebhook(rawBody: string, signature: string, clientSecret: string) {
  let supplied: Buffer;
  try { supplied = Buffer.from(signature.trim(), "base64"); }
  catch { return false; }
  const calculated = createHmac("sha256", clientSecret).update(rawBody).digest();
  return supplied.length === calculated.length && timingSafeEqual(supplied, calculated);
}

export async function parseVerifiedNinjaVanWebhook(db: Db, rawBody: string, signature: string) {
  const connection = await getNinjaVanConnection(db);
  if (!connection) throw new NinjaVanError("Ninja Van is not connected.", 401);
  if (!verifyNinjaVanWebhook(rawBody, signature, decryptNinjaVanClientSecret(connection))) {
    throw new NinjaVanError("The Ninja Van webhook signature is invalid.", 401);
  }
  let value: unknown;
  try { value = JSON.parse(rawBody); }
  catch { throw new NinjaVanError("The Ninja Van webhook body is not valid JSON.", 400); }
  const parsed = ninjaVanWebhookSchema.safeParse(value);
  if (!parsed.success || !Number.isFinite(new Date(parsed.data.timestamp).getTime())) {
    throw new NinjaVanError("The Ninja Van webhook payload is invalid.", 400);
  }
  return {
    event: parsed.data,
    fingerprint: createHash("sha256").update(rawBody).digest("hex"),
  };
}
