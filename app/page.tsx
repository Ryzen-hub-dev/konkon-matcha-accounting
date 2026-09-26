import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import styles from "./index.module.css";
import { CinematicIndexHero } from "@/components/cinematic-index-hero";
import { DEFAULT_BUSINESS_SETTINGS, normaliseBusinessSettings } from "@/lib/business-settings";
import { getDb } from "@/lib/db";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "Meet KONA · Run the Day in One Calm Flow",
  description: "Meet KONA, the interactive guide connecting Kōn-Kōn commerce, operations and accounting.",
  authors: [{ name: "Ryzen Hub Dev", url: "https://github.com/Ryzen-hub-dev" }],
  creator: "Ryzen Hub Dev",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f8f3e8" };
export const dynamic = "force-dynamic";

async function getPublicBranding() {
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

export default async function IndexPage() {
  const branding = await getPublicBranding();
  return (
    <main className={`${styles.home} ${inter.className}`}>
      <a className={styles.skip} href="#hero-content">Skip to content</a>
      <CinematicIndexHero
        businessName={branding.businessName}
        workspaceLogoDataUrl={branding.workspaceLogoDataUrl}
      />
    </main>
  );
}
