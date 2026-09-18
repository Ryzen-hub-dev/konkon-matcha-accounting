import { redirect } from "next/navigation";
import { ExpensesView } from "@/components/expenses-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export const metadata = { title: "Expense claims" };
export default async function ExpensesPage() {
  const session = await readSession();
  if (!session || !hasPermission(session.role, "expenses.read")) redirect("/dashboard");
  return <ExpensesView userId={session.id} />;
}
