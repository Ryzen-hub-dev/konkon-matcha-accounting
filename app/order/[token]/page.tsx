import type { Metadata } from "next";
import { PublicOrderView } from "@/components/public-order-view";

export const metadata: Metadata = {
  title: "Private order workspace",
  robots: { index: false, follow: false, noarchive: true },
};

export default async function OrderPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <PublicOrderView token={token} />;
}
