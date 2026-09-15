import type { Db } from "mongodb";
import { z } from "zod";
import { ensureHeadquarters } from "@/lib/locations";

export type CounterRecord = {
  _id: string;
  code: string;
  name: string;
  locationId: string;
  locationName: string;
  managerIds: string[];
  managerNames: string[];
  active: boolean;
  systemKey?: string;
  createdAt: string;
  updatedAt: string;
};

export const counterFields = z.object({
  code: z.string().trim().toUpperCase().min(2).max(24).regex(/^[A-Z0-9_-]+$/),
  name: z.string().trim().min(2).max(80),
  locationId: z.string().length(24),
  managerIds: z.array(z.string().length(24)).max(25).default([]).transform((ids) => [...new Set(ids)]),
});

export const counterUpdateSchema = counterFields.partial().extend({ id: z.string().length(24), active: z.boolean().optional() });

export async function ensureDefaultCounter(db: Db) {
  const headquarters = await ensureHeadquarters(db);
  if (!headquarters) throw new Error("HEADQUARTERS_UNAVAILABLE");
  const now = new Date();
  return db.collection("counters").findOneAndUpdate(
    { systemKey: "PRIMARY" },
    { $setOnInsert: { code: "MAIN", name: "Main counter", locationId: headquarters._id, locationName: String(headquarters.name), managerIds: [], managerNames: [], active: true, systemKey: "PRIMARY", createdAt: now, updatedAt: now } },
    { upsert: true, returnDocument: "after" },
  );
}
