import { redirect } from "next/navigation";
import { PaymentMethodsView } from "@/components/payment-methods-view";
import { readSession } from "@/lib/auth";

export const metadata = { title: "Payment methods" };

export default async function PaymentMethodsPage() {
  const session = await readSession();
  if (!session || !["OWNER", "ADMIN"].includes(session.role)) redirect("/dashboard");
  return <PaymentMethodsView />;
}
