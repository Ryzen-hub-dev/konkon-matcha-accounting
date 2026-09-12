import { createHmac, timingSafeEqual } from "node:crypto";
import type { Document } from "mongodb";
import { receiptTokenId } from "./scan-codes";
import { normaliseReceiptTemplate } from "./receipt-templates";

function signature(sale: Document) {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("Receipt access is not configured.");
  return createHmac("sha256", secret).update(`receipt-access-v1:${sale._id.toString()}:${sale.receiptAccessVersion || "legacy"}`).digest("hex");
}

export function receiptAccessToken(sale: Document) {
  return `KKR1-${sale._id.toString()}-${signature(sale)}`;
}

export function receiptAccessUrl(sale: Document, origin: string) {
  return `${new URL(origin).origin}/r#receipt=${receiptAccessToken(sale)}`;
}

export function validReceiptAccess(sale: Document, token: string) {
  if (sale.receiptAccessRevoked || receiptTokenId(token) !== sale._id.toString()) return false;
  const received = token.split("-")[2];
  return /^[a-f0-9]{64}$/i.test(received) && timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(signature(sale), "hex"));
}

/** Public receipt is an explicit allowlist: never costs, identities or tender references. */
export function publicReceipt(sale: Document) {
  const snapshot = sale.businessSnapshot || {};
  return {
    receiptNo: sale.receiptNo, createdAt: sale.createdAt, status: sale.status,
    items: (sale.items || []).map((item: Document) => ({ sku: item.sku, name: item.name, quantity: item.quantity, price: item.price, lineTotal: item.lineTotal, refundedQuantity: Number(item.refundedQuantity || 0) })),
    subtotal: sale.subtotal, discount: sale.discount, taxRate: sale.taxRate, taxMode: sale.taxMode,
    tax: sale.tax, total: sale.total, refundedAmount: Number(sale.refundedAmount || 0),
    paymentMethod: sale.paymentMethod, paymentMethodName: sale.paymentMethodName, paymentKind: sale.paymentKind,
    tenderCurrency: sale.tenderCurrency, tenderTotal: sale.tenderTotal, exchangeRate: sale.exchangeRate,
    tenderedAmount: sale.tenderedAmount, changeDue: sale.changeDue,
    templateSnapshot: normaliseReceiptTemplate(sale.templateSnapshot || {}),
    businessSnapshot: Object.fromEntries(["businessName", "legalEntityName", "registrationNo", "email", "phone", "address", "countryCode", "timeZone", "locale", "currency", "taxName", "franchiseBrand", "franchiseCode"].map(key => [key, snapshot[key]])),
    eInvoice: { schemaVersion: 1, sourceDocumentType: "POS_RECEIPT", sourceReceiptNo: sale.receiptNo, countryCode: snapshot.countryCode || "", status: "NOT_SUBMITTED" },
  };
}
