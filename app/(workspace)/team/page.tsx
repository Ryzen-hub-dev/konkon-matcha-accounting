import { redirect } from "next/navigation";
import { TeamView } from "@/components/team-view";
import { readSession } from "@/lib/auth";
export const metadata = { title: "Team & access" };
export default async function TeamPage() { const session = await readSession(); if (!session) redirect("/login"); return <TeamView actorRole={session.role} />; }
