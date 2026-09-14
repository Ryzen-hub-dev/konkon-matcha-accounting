export const OPERATIONAL_LOG_DAYS = 90;
export const EXPIRING_AUDIT_ACTIONS = [
  "auth.login", "member.identity_lookup", "member_card.reveal", "einvoice.download",
  "scanner.issue", "scanner.route", "scanner.revoke", "scanner.binding_start", "scanner.binding_finish",
  "payment-display.issue", "payment-display.revoke",
];
export function auditExpiry(action: string, createdAt: Date) {
  return EXPIRING_AUDIT_ACTIONS.includes(action) ? new Date(createdAt.getTime() + OPERATIONAL_LOG_DAYS * 86_400_000) : undefined;
}
