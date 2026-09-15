import type { UserRole } from "@/lib/types";

export const PERMISSIONS = [
  "dashboard.read",
  "pos.sell",
  "payments.read",
  "payments.manage",
  "coupons.read",
  "coupons.manage",
  "receipts.read",
  "receipts.manage",
  "members.read",
  "members.write",
  "inventory.read",
  "inventory.write",
  "purchasing.read",
  "purchasing.write",
  "purchasing.approve",
  "payables.read",
  "payables.write",
  "accounting.read",
  "accounting.write",
  "invoices.read",
  "invoices.write",
  "reports.read",
  "counters.read",
  "counters.manage",
  "team.read",
  "team.write",
  "settings.read",
  "settings.write",
  "owner.control",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const rolePermissions: Record<UserRole, ReadonlySet<Permission>> = {
  OWNER: new Set(PERMISSIONS),
  ADMIN: new Set(PERMISSIONS.filter((permission) => permission !== "owner.control")),
  MANAGER: new Set([
    "dashboard.read", "pos.sell", "members.read", "members.write", "inventory.read",
    "inventory.write", "invoices.read", "invoices.write", "reports.read", "team.read",
    "receipts.read", "receipts.manage", "coupons.read", "coupons.manage", "payments.read",
    "purchasing.read", "purchasing.write", "purchasing.approve", "payables.read", "counters.read",
  ]),
  ACCOUNTANT: new Set([
    "dashboard.read", "members.read", "inventory.read", "accounting.read",
    "accounting.write", "invoices.read", "invoices.write", "reports.read", "receipts.read", "payments.read",
    "purchasing.read", "purchasing.write", "payables.read", "payables.write",
  ]),
  CASHIER: new Set(["dashboard.read", "pos.sell", "payments.read", "coupons.read", "receipts.read", "members.read", "members.write", "inventory.read", "counters.read"]),
};

export const ROLE_PROFILES: Record<UserRole, { label: string; summary: string }> = {
  OWNER: { label: "Owner", summary: "Company authority, security controls and every operational permission." },
  ADMIN: { label: "Admin", summary: "Runs the workspace and staff, but cannot transfer ownership or close the company." },
  MANAGER: { label: "Manager", summary: "Runs assigned counters, sales, stock, members, purchasing and reports." },
  ACCOUNTANT: { label: "Accountant", summary: "Maintains books, invoices, payables and reports without operational control." },
  CASHIER: { label: "Cashier", summary: "Sells, serves members and reads stock, receipts, coupons and payment methods." },
};

export const ACCESS_AREAS: ReadonlyArray<{ label: string; read: Permission; manage?: Permission; useLabel?: string }> = [
  { label: "Dashboard", read: "dashboard.read" },
  { label: "Point of sale", read: "pos.sell", useLabel: "USE" },
  { label: "Counters", read: "counters.read", manage: "counters.manage" },
  { label: "Payment methods", read: "payments.read", manage: "payments.manage" },
  { label: "Coupons", read: "coupons.read", manage: "coupons.manage" },
  { label: "Receipts & refunds", read: "receipts.read", manage: "receipts.manage" },
  { label: "Members", read: "members.read", manage: "members.write" },
  { label: "Inventory", read: "inventory.read", manage: "inventory.write" },
  { label: "Purchasing", read: "purchasing.read", manage: "purchasing.write" },
  { label: "Payables", read: "payables.read", manage: "payables.write" },
  { label: "Accounting", read: "accounting.read", manage: "accounting.write" },
  { label: "Invoices", read: "invoices.read", manage: "invoices.write" },
  { label: "Reports", read: "reports.read" },
  { label: "Team", read: "team.read", manage: "team.write" },
  { label: "Workspace", read: "settings.read", manage: "settings.write" },
  { label: "Ownership & shutdown", read: "owner.control", manage: "owner.control" },
];

export function hasPermission(role: UserRole, permission: Permission) {
  return rolePermissions[role].has(permission);
}

export function accessLevel(role: UserRole, area: (typeof ACCESS_AREAS)[number]) {
  if (area.manage && hasPermission(role, area.manage)) return "MANAGE" as const;
  if (hasPermission(role, area.read)) return (area.useLabel || "VIEW") as "USE" | "VIEW";
  return "NONE" as const;
}

export function canManageRole(actor: UserRole, target: UserRole) {
  if (actor === "OWNER") return target !== "OWNER";
  if (actor === "ADMIN") return !["OWNER", "ADMIN"].includes(target);
  return false;
}
