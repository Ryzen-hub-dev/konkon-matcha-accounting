import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { OwnerRecoveryForm } from "@/components/owner-recovery-form";

export const metadata: Metadata = {
  title: "Register replacement Owner",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

// A deleted Owner may still have a signed cookie. The one-time grant, not that
// stale cookie, controls this page; successful registration replaces the cookie.
export default function RecoverOwnerPage() {
  return <AuthShell><OwnerRecoveryForm /></AuthShell>;
}
