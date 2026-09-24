import type { Metadata } from "next";
import { StorefrontView } from "@/components/storefront-view";

export const metadata: Metadata = {
  title: "Online order desk",
  description: "Browse available products and request a confirmed online order.",
  robots: { index: true, follow: true },
};

export default function ShopPage() {
  return <StorefrontView />;
}
