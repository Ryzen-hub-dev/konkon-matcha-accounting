import { z } from "zod";

export const SHIPPING_PROVIDER_IDS = ["GDEX", "ABX", "NINJA_VAN", "OTHER"] as const;
export type ShippingProviderId = (typeof SHIPPING_PROVIDER_IDS)[number];

export type ShippingProvider = {
  id: ShippingProviderId;
  name: string;
  aliases: readonly string[];
  countries: readonly string[];
  trackingUrl: string;
  developerUrl: string;
  connection: "ACCOUNT_SUBSCRIPTION" | "PARTNER_ONBOARDING" | "PUBLIC_DOCUMENTATION" | "MANUAL";
  capabilities: readonly string[];
  note: string;
};

export const SHIPPING_PROVIDERS: readonly ShippingProvider[] = [
  {
    id: "GDEX",
    name: "GDEX",
    aliases: ["GD EXPRESS", "MYGDEX"],
    countries: ["MY"],
    trackingUrl: "https://www.gdexpress.com/malaysia/e-tracking",
    developerUrl: "https://myopenplatform.gdexpress.com/",
    connection: "ACCOUNT_SUBSCRIPTION",
    capabilities: ["TRACKING_PORTAL", "CONSIGNMENT", "PICKUP"],
    note: "Subscription Key and User Token are issued through the official myGDEX developer and customer portals.",
  },
  {
    id: "ABX",
    name: "ABX Express",
    aliases: ["ABX EXPRESS", "KEX", "KEX EXPRESS"],
    countries: ["MY"],
    trackingUrl: "https://www.abxexpress.com.my/tracking",
    developerUrl: "https://www.abxexpress.com.my/abxexpress-services",
    connection: "PARTNER_ONBOARDING",
    capabilities: ["TRACKING_PORTAL", "SHIPMENT", "PICKUP", "DIGITAL_COD_FOD"],
    note: "ABX advertises corporate API integration, but supplies the operational contract during partner onboarding.",
  },
  {
    id: "NINJA_VAN",
    name: "Ninja Van",
    aliases: ["NINJAVAN", "NINJA VAN MY"],
    countries: ["MY", "SG", "TH", "ID", "VN", "PH", "MM"],
    trackingUrl: "https://www.ninjavan.co/en-my/tracking",
    developerUrl: "https://api-docs.ninjavan.co/",
    connection: "PUBLIC_DOCUMENTATION",
    capabilities: ["TRACKING_PORTAL", "OAUTH", "ORDER", "WAYBILL", "CANCELLATION", "TARIFF", "WEBHOOK"],
    note: "Public API documentation is available; live calls still require an approved shipper account and private credentials.",
  },
  {
    id: "OTHER",
    name: "Manual / other carrier",
    aliases: [],
    countries: [],
    trackingUrl: "",
    developerUrl: "",
    connection: "MANUAL",
    capabilities: ["MANUAL_REFERENCE"],
    note: "Store a carrier name and dispatch reference without claiming a live carrier connection.",
  },
] as const;

const aliasMap = new Map<string, ShippingProviderId>();
for (const provider of SHIPPING_PROVIDERS) {
  for (const alias of [provider.id, provider.name, ...provider.aliases]) aliasMap.set(normaliseAlias(alias), provider.id);
}

function normaliseAlias(value: string) {
  return value.normalize("NFKC").trim().toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

export function findShippingProvider(value: unknown) {
  const id = aliasMap.get(normaliseAlias(String(value || ""))) || "OTHER";
  return SHIPPING_PROVIDERS.find(provider => provider.id === id)!;
}

export const shippingProviderIdSchema = z.preprocess(
  value => findShippingProvider(value).id,
  z.enum(SHIPPING_PROVIDER_IDS),
);

export const shippingTrackingReferenceSchema = z.string().trim().min(4).max(100)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/, "Use only letters, numbers, dots, underscores or hyphens.");

export const trackingLinkRequestSchema = z.object({
  provider: shippingProviderIdSchema,
  trackingReferences: z.array(shippingTrackingReferenceSchema).min(1).max(20),
}).strict();

export function resolveTrackingLinks(input: z.infer<typeof trackingLinkRequestSchema>) {
  const provider = findShippingProvider(input.provider);
  if (!provider.trackingUrl) throw new Error("Choose a supported carrier to open official tracking.");
  return {
    provider: { id: provider.id, name: provider.name },
    trackingUrl: provider.trackingUrl,
    trackingReferences: [...new Set(input.trackingReferences.map(value => value.trim()))],
    handoff: "COPY_REFERENCE_AND_OPEN_OFFICIAL_PORTAL" as const,
  };
}

export function normaliseCarrierSelection(providerValue: unknown, carrierValue: unknown) {
  const provider = findShippingProvider(providerValue);
  const manualCarrier = String(carrierValue || "").trim();
  return {
    carrierCode: provider.id,
    carrier: provider.id === "OTHER" ? manualCarrier : provider.name,
  };
}
