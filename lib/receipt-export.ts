export function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function receiptCsv(receipt: { receiptNo: string; createdAt: string | Date; items: Array<{ sku?: string; name: string; quantity: number; price: number; lineTotal: number; refundedQuantity?: number }>; subtotal: number; discount: number; tax: number; total: number; refundedAmount?: number; businessSnapshot?: { currency?: string } }) {
  const currency = receipt.businessSnapshot?.currency || "";
  const rows: unknown[][] = [["Receipt", "Date", "Currency", "SKU", "Description", "Quantity", "Unit price", "Line total", "Refunded quantity"]];
  for (const item of receipt.items) rows.push([receipt.receiptNo, new Date(receipt.createdAt).toISOString(), currency, item.sku || "", item.name, item.quantity, item.price, item.lineTotal, item.refundedQuantity || 0]);
  rows.push([], ["Subtotal", receipt.subtotal], ["Discount", receipt.discount], ["Tax", receipt.tax], ["Total", receipt.total], ["Refunded", receipt.refundedAmount || 0], ["Net retained", receipt.total - (receipt.refundedAmount || 0)]);
  return "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n");
}

export function downloadReceiptFile(content: string, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a"); link.href = url; link.download = filename.replace(/[^a-zA-Z0-9._-]/g, "_"); link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
