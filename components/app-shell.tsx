"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  BarChart3, BookOpen, Boxes, ChevronLeft, ChevronRight, CircleDollarSign,
  FileText, LayoutDashboard, LogOut, Menu, Settings, ShoppingBasket, Sprout,
  Users, X,
} from "lucide-react";
import type { SessionUser, UserRole } from "@/lib/types";

type NavItem = { href: string; label: string; icon: typeof LayoutDashboard; roles?: UserRole[] };

const nav: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/pos", label: "Point of sale", icon: ShoppingBasket, roles: ["OWNER", "ADMIN", "MANAGER", "CASHIER"] },
  { href: "/members", label: "Members", icon: Users },
  { href: "/inventory", label: "Inventory", icon: Boxes },
  { href: "/accounting", label: "Accounting", icon: BookOpen, roles: ["OWNER", "ADMIN", "ACCOUNTANT"] },
  { href: "/invoices", label: "Invoices", icon: FileText, roles: ["OWNER", "ADMIN", "MANAGER", "ACCOUNTANT"] },
  { href: "/reports", label: "Reports", icon: BarChart3, roles: ["OWNER", "ADMIN", "MANAGER", "ACCOUNTANT"] },
  { href: "/team", label: "Team & access", icon: Users, roles: ["OWNER", "ADMIN", "MANAGER"] },
  { href: "/settings", label: "Workspace", icon: Settings, roles: ["OWNER", "ADMIN"] },
];

export function AppShell({ user, children }: { user: SessionUser; children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const visibleNav = nav.filter((item) => !item.roles || item.roles.includes(user.role));
  const current = visibleNav.find((item) => path === item.href || path.startsWith(`${item.href}/`))?.label || "Kōn-Kōn Ledger";

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className={`app-frame ${collapsed ? "sidebar-collapsed" : ""}`}>
      <button className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu /></button>
      {mobileOpen ? <button className="mobile-scrim" onClick={() => setMobileOpen(false)} aria-label="Close navigation" /> : null}
      <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
        <div className="brand-lockup">
          <div className="brand-mark"><Sprout size={21} /></div>
          <div className="brand-words"><strong>KŌN-KŌN</strong><span>Matchā ledger</span></div>
          <button className="mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={19} /></button>
        </div>
        <div className="sidebar-rule"><span>MENU</span></div>
        <nav aria-label="Main navigation">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const active = path === item.href || path.startsWith(`${item.href}/`);
            return (
              <Link key={item.href} href={item.href} className={active ? "active" : ""} title={collapsed ? item.label : undefined} onClick={() => setMobileOpen(false)}>
                <Icon size={19} strokeWidth={1.7} /><span>{item.label}</span>{active ? <i /> : null}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="user-chip">
            <div className="avatar">{user.fullName.split(/\s+/).map((word) => word[0]).join("").slice(0, 2).toUpperCase()}</div>
            <div><strong>{user.fullName}</strong><span>{user.role}</span></div>
            <button onClick={logout} aria-label="Sign out" title="Sign out"><LogOut size={17} /></button>
          </div>
          <button className="collapse-button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {collapsed ? <ChevronRight size={17} /> : <><ChevronLeft size={17} /><span>Collapse</span></>}
          </button>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div><span className="topbar-kicker">OPERATIONS /</span><strong>{current}</strong></div>
          <div className="topbar-meta"><span className="live-dot" />LIVE LEDGER <i /> <span>{new Intl.DateTimeFormat("en-SG", { weekday: "short", day: "2-digit", month: "short" }).format(new Date())}</span></div>
        </header>
        <main>{children}</main>
        <footer className="app-footer"><span>KŌN-KŌN MATCHĀ · SINGAPORE</span><span>Books kept fresh, one whisk at a time.</span></footer>
      </div>
    </div>
  );
}
