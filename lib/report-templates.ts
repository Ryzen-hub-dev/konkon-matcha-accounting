import { z } from "zod";

export const REPORT_LAYOUTS = {
  PROFIT_LOSS: ["REVENUE", "COST_OF_SALES", "OPERATING_EXPENSES", "NET_PROFIT"],
  BALANCE_SHEET: ["ASSETS", "LIABILITIES", "EQUITY"],
  CASH_FLOW: [
    "OPENING",
    "OPERATING",
    "INVESTING",
    "FINANCING",
    "UNCLASSIFIED",
    "CLOSING",
  ],
  TRIAL_BALANCE: ["OPENING", "PERIOD", "CLOSING"],
  AGING: ["RECEIVABLES", "PAYABLES"],
} as const;

export type ReportLayoutType = keyof typeof REPORT_LAYOUTS;

const base = z.object({
  name: z.string().trim().min(2).max(80),
  reportType: z.enum(
    Object.keys(REPORT_LAYOUTS) as [ReportLayoutType, ...ReportLayoutType[]],
  ),
  title: z.string().trim().min(2).max(120),
  subtitle: z.string().trim().max(240).default(""),
  orientation: z.enum(["PORTRAIT", "LANDSCAPE"]).default("PORTRAIT"),
  accent: z.enum(["MATCHA", "INK", "PLUM"]).default("MATCHA"),
  showZeroRows: z.boolean().default(false),
  showAccountCodes: z.boolean().default(true),
  sections: z.array(z.string().trim()).min(1).max(8),
});

function validSections(value: z.infer<typeof base>, context: z.RefinementCtx) {
  const allowed = REPORT_LAYOUTS[value.reportType] as readonly string[];
  if (
    new Set(value.sections).size !== value.sections.length ||
    value.sections.some((section) => !allowed.includes(section))
  ) {
    context.addIssue({
      code: "custom",
      path: ["sections"],
      message: "Choose each available report section once.",
    });
  }
}

export const reportTemplateMutationSchema = z.discriminatedUnion("action", [
  base
    .extend({
      action: z.literal("SAVE"),
      id: z
        .string()
        .regex(/^[a-f0-9]{24}$/i)
        .optional(),
      expectedVersion: z.coerce.number().int().min(0).default(0),
    })
    .strict()
    .superRefine(validSections),
  z
    .object({
      action: z.literal("DELETE"),
      id: z.string().regex(/^[a-f0-9]{24}$/i),
      expectedVersion: z.coerce.number().int().min(1),
    })
    .strict(),
]);

export function defaultReportTemplate(reportType: ReportLayoutType) {
  const labels: Record<ReportLayoutType, string> = {
    PROFIT_LOSS: "Profit & loss",
    BALANCE_SHEET: "Balance sheet",
    CASH_FLOW: "Cash flow statement",
    TRIAL_BALANCE: "Trial balance",
    AGING: "Receivables & payables aging",
  };
  return {
    name: `${labels[reportType]} layout`,
    reportType,
    title: labels[reportType],
    subtitle: "",
    orientation:
      reportType === "TRIAL_BALANCE"
        ? ("LANDSCAPE" as const)
        : ("PORTRAIT" as const),
    accent: "MATCHA" as const,
    showZeroRows: false,
    showAccountCodes: true,
    sections: [...REPORT_LAYOUTS[reportType]],
  };
}
