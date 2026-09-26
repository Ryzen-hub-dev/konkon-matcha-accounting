import type { Metadata } from "next";
import { PaymentDisplay } from "@/components/payment-display";
import { readPublicBranding } from "@/lib/public-branding";

export const metadata: Metadata = {
  title: "Customer payment display",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function CustomerPaymentDisplayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const branding = await readPublicBranding();
  return <PaymentDisplay token={token} branding={branding} />;
}
