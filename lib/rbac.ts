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
  "team.read",
  "team.write",
  "settings.read",
  "settings.write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const rolePermissions: Record<UserRole, ReadonlySet<Permission>> = {
  OWNER: new Set(PERMISSIONS),
  ADMIN: new Set(PERMISSIONS),
  MANAGER: new Set([
    "dashboard.read", "pos.sell", "members.read", "members.write", "inventory.read",
    "inventory.write", "invoices.read", "invoices.write", "reports.read", "team.read",
    "receipts.read", "receipts.manage", "coupons.read", "coupons.manage", "payments.read",
    "purchasing.read", "purchasing.write", "purchasing.approve", "payables.read",
  ]),
  ACCOUNTANT: new Set([
    "dashboard.read", "members.read", "inventory.read", "accounting.read",
    "accounting.write", "invoices.read", "invoices.write", "reports.read", "receipts.read", "payments.read",
    "purchasing.read", "purchasing.write", "payables.read", "payables.write",
  ]),
  CASHIER: new Set(["dashboard.read", "pos.sell", "payments.read", "coupons.read", "receipts.read", "members.read", "members.write", "inventory.read"]),
};

export function hasPermission(role: UserRole, permission: Permission) {
  return rolePermissions[role].has(permission);
}

export function canManageRole(actor: UserRole, target: UserRole) {
  if (actor === "OWNER") return target !== "OWNER";
  if (actor === "ADMIN") return !["OWNER", "ADMIN"].includes(target);
  return false;
}
