import { PublicReceiptView } from "@/components/public-receipt-view";
export const metadata = { title: "Your receipt", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export default function ReceiptPage() { return <PublicReceiptView />; }
