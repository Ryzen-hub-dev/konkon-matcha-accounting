import { ReceiptDocumentView } from "@/components/receipt-document-view";
import { readSession } from "@/lib/auth";
export const metadata = { title: "Receipt paper" };
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await readSession();
  return <ReceiptDocumentView id={id} canRefund={Boolean(session && ["OWNER", "ADMIN", "MANAGER"].includes(session.role))} canSell={Boolean(session && ["OWNER", "ADMIN", "MANAGER", "CASHIER"].includes(session.role))} />;
}
