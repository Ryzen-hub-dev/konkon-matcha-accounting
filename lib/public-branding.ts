import "server-only";
import { DEFAULT_BUSINESS_SETTINGS, normaliseBusinessSettings, type PublicBranding } from "@/lib/business-settings";
import { getDb } from "@/lib/db";

export async function readPublicBranding(): Promise<PublicBranding> {
  try {
    const db = await getDb();
    const settings = normaliseBusinessSettings(await db.collection("settings").findOne(
      { key: "business" },
      { projection: { businessName: 1, workspaceLogoDataUrl: 1 } },
    ));
    return { businessName: settings.businessName, workspaceLogoDataUrl: settings.workspaceLogoDataUrl };
  } catch {
    return {
      businessName: DEFAULT_BUSINESS_SETTINGS.businessName,
      workspaceLogoDataUrl: DEFAULT_BUSINESS_SETTINGS.workspaceLogoDataUrl,
    };
  }
}
