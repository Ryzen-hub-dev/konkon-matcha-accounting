import { z } from "zod";
import { countryCodeSchema, currencyCodeSchema, localeSchema, timeZoneSchema } from "@/lib/international";

export const LOCATION_TYPES = ["HEADQUARTERS", "BRANCH", "WAREHOUSE", "FRANCHISE"] as const;

export type LocationRecord = {
  _id: string;
  code: string;
  name: string;
  type: (typeof LOCATION_TYPES)[number];
  countryCode: string;
  timeZone: string;
  locale: string;
  currency: string;
  address: string;
  parentLocationId?: string;
  parentLocationName?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export const locationFields = z.object({
  code: z.string().trim().toUpperCase().min(2).max(32).regex(/^[A-Z0-9_-]+$/),
  name: z.string().trim().min(2).max(100),
  type: z.enum(LOCATION_TYPES),
  countryCode: countryCodeSchema,
  timeZone: timeZoneSchema,
  locale: localeSchema,
  currency: currencyCodeSchema,
  address: z.string().trim().max(300).default(""),
  parentLocationId: z.union([z.string().length(24), z.literal("")]).default(""),
});

export const locationUpdateSchema = locationFields.partial().extend({ id: z.string().length(24), active: z.boolean().optional() });

export async function locationParentChainIsValid(
  parentLocationId: string,
  ownId: string,
  readParentId: (id: string) => Promise<string | null | undefined>,
) {
  const visited = new Set<string>();
  let currentId: string | null = parentLocationId;
  for (let depth = 0; currentId && depth < 256; depth += 1) {
    if (currentId === ownId || visited.has(currentId)) return false;
    visited.add(currentId);
    const nextId = await readParentId(currentId);
    if (nextId === undefined) return false;
    currentId = nextId;
  }
  return currentId === null;
}
