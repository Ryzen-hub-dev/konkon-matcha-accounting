import type { Metadata } from "next";
import { MobileScanner } from "@/components/mobile-scanner";

export const metadata: Metadata = {
  title: "Mobile scanner pass",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function MobileScannerPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <MobileScanner token={token} />;
}
