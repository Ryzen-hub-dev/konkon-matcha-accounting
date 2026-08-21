import { MembersView } from "@/components/members-view";
import { readSession } from "@/lib/auth";
export const metadata = { title: "Members" };
export default async function MembersPage() { const session = await readSession(); return <MembersView canWrite={Boolean(session && session.role !== "ACCOUNTANT")} />; }
