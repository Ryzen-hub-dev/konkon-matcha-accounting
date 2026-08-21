import { MemberCardView } from "@/components/member-card-view";

export const metadata = { title: "Member card" };

export default async function MemberCardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MemberCardView memberId={id} />;
}
