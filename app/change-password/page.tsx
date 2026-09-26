import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { ForcedPasswordForm } from "@/components/forced-password-form";
import { readSession } from "@/lib/auth";
import { readPublicBranding } from "@/lib/public-branding";

export const metadata = { title: "Change temporary password" };

export default async function ChangePasswordPage() {
  const session = await readSession();
  if (!session) redirect("/login");
  if (!session.mustChangePassword) redirect("/dashboard");
  const branding = await readPublicBranding();
  return <AuthShell businessName={branding.businessName} logoDataUrl={branding.workspaceLogoDataUrl}><ForcedPasswordForm /></AuthShell>;
}
