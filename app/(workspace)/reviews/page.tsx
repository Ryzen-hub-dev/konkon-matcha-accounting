import { redirect } from "next/navigation";
import { OperationalReviewsView } from "@/components/operational-reviews-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export const metadata = { title: "Exception reviews" };

export default async function ReviewsPage() {
  const session = await readSession();
  if (!session) redirect("/login");
  if (!hasPermission(session.role, "reviews.read")) redirect("/dashboard");
  return <OperationalReviewsView canManage={hasPermission(session.role, "reviews.manage")} />;
}
