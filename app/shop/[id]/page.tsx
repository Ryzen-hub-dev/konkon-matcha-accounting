import type { Metadata } from "next";
import { StorefrontView } from "@/components/storefront-view";

export const metadata: Metadata = {
  title: "Product details",
  description: "View live availability and request a confirmed online order.",
  robots: { index: true, follow: true },
};

export default async function ProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <StorefrontView productId={id} />;
}
