import { MemberCardView } from "@/components/member-card-view";
import { readSession } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export const metadata = { title: "Member card" };

export default async function MemberCardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await readSession();
  return <MemberCardView memberId={id} canWrite={Boolean(session && hasPermission(session.role, "members.write"))} />;
}
