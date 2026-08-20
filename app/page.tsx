import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  redirect((await readSession()) ? "/dashboard" : "/login");
}
