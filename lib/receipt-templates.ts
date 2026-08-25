import type { ClientSession, Db } from "mongodb";
import { z } from "zod";

export const RECEIPT_PAPER_WIDTHS = ["58MM", "80MM"] as const;
export const RECEIPT_DENSITIES = ["COMPACT", "COMFORTABLE"] as const;

const logoDataUrlSchema = z.string().max(350_000).refine(
  (value) => value === "" || /^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value),
  "Upload a PNG, JPEG or WebP logo under 250 KB.",
);

export const receiptTemplateInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  paperWidth: z.enum(RECEIPT_PAPER_WIDTHS),
  density: z.enum(RECEIPT_DENSITIES),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Choose a six-digit hex colour."),
  logoDataUrl: logoDataUrlSchema.default(""),
  receiptTitle: z.string().trim().min(2).max(50).default("SALES RECEIPT"),
  headerText: z.string().trim().max(160).default(""),
  thankYouText: z.string().trim().max(180).default(""),
  footerText: z.string().trim().max(300).default(""),
  returnPolicy: z.string().trim().max(400).default(""),
  website: z.string().trim().max(160).default(""),
  showBusinessAddress: z.boolean().default(false),
  showRegistrationNo: z.boolean().default(true),
  showTaxBreakdown: z.boolean().default(true),
  showSku: z.boolean().default(false),
  showCashier: z.boolean().default(true),
  showMember: z.boolean().default(true),
  showPaymentDetails: z.boolean().default(true),
  showPoints: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});

export type ReceiptTemplateInput = z.infer<typeof receiptTemplateInputSchema>;
export type ReceiptTemplateRecord = ReceiptTemplateInput & {
  _id: string;
  createdAt: string;
  updatedAt: string;
};

export const DEFAULT_RECEIPT_TEMPLATE: ReceiptTemplateInput = {
  name: "Matcha counter",
  paperWidth: "80MM",
  density: "COMFORTABLE",
  accentColor: "#173f2a",
  logoDataUrl: "",
  receiptTitle: "SALES RECEIPT",
  headerText: "KŌN-KŌN MATCHĀ · SINGAPORE",
  thankYouText: "Thank you for sharing a bowl with us.",
  footerText: "Prepared fresh at the Kōn-Kōn counter.",
  returnPolicy: "Please keep this receipt for exchanges. Sealed goods may be exchanged within 7 days.",
  website: "konkonmatcha.com",
  showBusinessAddress: false,
  showRegistrationNo: true,
  showTaxBreakdown: true,
  showSku: false,
  showCashier: true,
  showMember: true,
  showPaymentDetails: true,
  showPoints: true,
  isDefault: true,
};

export function normaliseReceiptTemplate(value: unknown): ReceiptTemplateInput {
  const parsed = receiptTemplateInputSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_RECEIPT_TEMPLATE };
}

export async function ensureDefaultReceiptTemplate(db: Db, createdBy: unknown = null, session?: ClientSession) {
  const now = new Date();
  await db.collection("receiptTemplates").updateOne(
    {
      $or: [
        { systemKey: "starter-receipt-template" },
        { nameNormalized: DEFAULT_RECEIPT_TEMPLATE.name.toLocaleLowerCase("en-SG") },
      ],
    },
    {
      $set: { systemKey: "starter-receipt-template", showBusinessAddress: false },
      $setOnInsert: {
        ...DEFAULT_RECEIPT_TEMPLATE,
        nameNormalized: DEFAULT_RECEIPT_TEMPLATE.name.toLocaleLowerCase("en-SG"),
        active: true,
        createdBy,
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true, ...(session ? { session } : {}) },
  );
}
