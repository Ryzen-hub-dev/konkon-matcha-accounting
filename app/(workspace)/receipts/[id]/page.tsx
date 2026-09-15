import { ReceiptDocumentView } from "@/components/receipt-document-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
export const metadata = { title: "Receipt paper" };
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await readSession();
  return <ReceiptDocumentView id={id} canRefund={Boolean(session && hasPermission(session.role, "receipts.manage"))} canSell={Boolean(session && hasPermission(session.role, "pos.sell"))} />;
}
