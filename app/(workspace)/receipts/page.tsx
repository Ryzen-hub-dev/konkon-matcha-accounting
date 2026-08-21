import { ReceiptsView } from "@/components/receipts-view";
import { readSession } from "@/lib/auth";
export const metadata = { title: "Receipts" };
export default async function ReceiptsPage() {
  const session = await readSession();
  return <ReceiptsView canSell={Boolean(session && ["OWNER", "ADMIN", "MANAGER", "CASHIER"].includes(session.role))} />;
}
