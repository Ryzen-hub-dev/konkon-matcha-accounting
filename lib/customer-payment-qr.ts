export function staticQrInputSignature(input: {
  paymentMethodId: string;
  recipientPayload: string;
  currency: string;
  amount: number;
}) {
  const paymentMethodId = input.paymentMethodId.trim();
  const recipientPayload = input.recipientPayload.trim();
  const currency = input.currency.trim().toUpperCase();
  if (!paymentMethodId || recipientPayload.length < 8 || !/^[A-Z]{3}$/.test(currency) || !Number.isFinite(input.amount) || input.amount <= 0) return "";
  return JSON.stringify([paymentMethodId, recipientPayload, currency, input.amount]);
}

export function customerQrDisplaySignature(inputSignature: string, amountLocked: boolean) {
  return inputSignature ? JSON.stringify([inputSignature, amountLocked]) : "";
}
