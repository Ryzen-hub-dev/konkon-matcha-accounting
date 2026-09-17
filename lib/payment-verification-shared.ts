export const PAYMENT_VERIFICATION_MODES = ["NONE", "REFERENCE", "STATIC_QR", "PROVIDER"] as const;
export const PAYMENT_PROVIDERS = ["GENERIC", "PAYNOW", "DUITNOW", "TNG", "GRABPAY", "ALIPAY", "WECHATPAY", "UNIONPAY"] as const;
export type PaymentVerificationMode = (typeof PAYMENT_VERIFICATION_MODES)[number];
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];
