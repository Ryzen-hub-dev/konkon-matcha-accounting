import type { Metadata } from "next";
import { PaymentDisplay } from "@/components/payment-display";

export const metadata: Metadata = {
  title: "Customer payment display",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function CustomerPaymentDisplayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PaymentDisplay token={token} />;
}
