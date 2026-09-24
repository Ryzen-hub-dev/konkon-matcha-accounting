import type { ClientSession, Db } from "mongodb";
import { z } from "zod";
import { countryCodeSchema, roundCurrency } from "@/lib/international";
import { isValidDateKey } from "@/lib/dates";

export const PAYROLL_ACCOUNTS = [
  { code: "2110", name: "Payroll payable", type: "LIABILITY" },
  { code: "2120", name: "Payroll deductions payable", type: "LIABILITY" },
  {
    code: "2130",
    name: "Employer payroll contributions payable",
    type: "LIABILITY",
  },
  { code: "2140", name: "EPF payable", type: "LIABILITY" },
  { code: "2150", name: "SOCSO payable", type: "LIABILITY" },
  { code: "2160", name: "EIS payable", type: "LIABILITY" },
  { code: "2170", name: "PCB payable", type: "LIABILITY" },
  { code: "2180", name: "Zakat and CP38 payable", type: "LIABILITY" },
  { code: "6110", name: "Wages and salaries", type: "EXPENSE" },
  { code: "6120", name: "Employer payroll contributions", type: "EXPENSE" },
] as const;

const amountSchema = z.coerce.number().min(0).max(100_000_000);
const positiveAmountSchema = z.coerce.number().gt(0).max(100_000_000);
const accountCodeSchema = z.string().trim().min(3).max(12);
const periodKeySchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/);

export const payrollMutationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("UPSERT_PROFILE"),
      id: z
        .string()
        .regex(/^[a-f0-9]{24}$/i)
        .optional(),
      expectedVersion: z.coerce.number().int().min(0).default(0),
      userId: z.string().regex(/^[a-f0-9]{24}$/i),
      employeeNo: z
        .string()
        .trim()
        .toUpperCase()
        .min(2)
        .max(30)
        .regex(/^[A-Z0-9_-]+$/),
      countryCode: countryCodeSchema,
      effectiveFrom: z
        .string()
        .refine(isValidDateKey, "Choose a valid effective date."),
      active: z.boolean().default(true),
      basePay: positiveAmountSchema,
      fixedAllowance: amountSchema.default(0),
      employeeDeduction: amountSchema.default(0),
      employerContribution: amountSchema.default(0),
      deductionLabel: z.string().trim().max(80).default("Employee deductions"),
      contributionLabel: z
        .string()
        .trim()
        .max(80)
        .default("Employer contributions"),
      wageExpenseAccountCode: accountCodeSchema.default("6110"),
      contributionExpenseAccountCode: accountCodeSchema.default("6120"),
      payrollPayableAccountCode: accountCodeSchema.default("2110"),
      deductionPayableAccountCode: accountCodeSchema.default("2120"),
      contributionPayableAccountCode: accountCodeSchema.default("2130"),
      epfPayableAccountCode: accountCodeSchema.default("2140"),
      socsoPayableAccountCode: accountCodeSchema.default("2150"),
      eisPayableAccountCode: accountCodeSchema.default("2160"),
      pcbPayableAccountCode: accountCodeSchema.default("2170"),
      zakatPayableAccountCode: accountCodeSchema.default("2180"),
    })
    .strict(),
  z
    .object({
      action: z.literal("CREATE_RUN"),
      periodKey: periodKeySchema,
      payDate: z.string().refine(isValidDateKey, "Choose a valid pay date."),
      clientRequestId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("ADJUST_EMPLOYEE"),
      id: z.string().regex(/^[a-f0-9]{24}$/i),
      expectedVersion: z.coerce.number().int().min(1),
      employeeNo: z.string().trim().toUpperCase().min(2).max(30),
      bonus: amountSchema.default(0),
      overtimePay: amountSchema.default(0),
      additionalDeduction: amountSchema.default(0),
      reason: z.string().trim().min(3).max(300),
    })
    .strict(),
  z
    .object({
      action: z.literal("SET_MALAYSIA_STATUTORY"),
      id: z.string().regex(/^[a-f0-9]{24}$/i),
      expectedVersion: z.coerce.number().int().min(1),
      employeeNo: z.string().trim().toUpperCase().min(2).max(30),
      epfEmployee: amountSchema.default(0),
      epfEmployer: amountSchema.default(0),
      socsoEmployee: amountSchema.default(0),
      socsoEmployer: amountSchema.default(0),
      eisEmployee: amountSchema.default(0),
      eisEmployer: amountSchema.default(0),
      pcb: amountSchema.default(0),
      zakat: amountSchema.default(0),
      cp38: amountSchema.default(0),
      sourceReference: z.string().trim().min(3).max(200),
      confirmed: z.literal(true),
    })
    .strict()
    .superRefine((value, context) => {
      for (const field of [
        "epfEmployee",
        "epfEmployer",
        "socsoEmployee",
        "socsoEmployer",
        "eisEmployee",
        "eisEmployer",
        "pcb",
        "zakat",
        "cp38",
      ] as const) {
        if (Math.abs(value[field] - roundCurrency(value[field], "MYR")) > 1e-8)
          context.addIssue({
            code: "custom",
            path: [field],
            message: "Use valid MYR precision.",
          });
      }
    }),
  z
    .object({
      action: z.literal("APPROVE_RUN"),
      id: z.string().regex(/^[a-f0-9]{24}$/i),
      expectedVersion: z.coerce.number().int().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("POST_RUN"),
      id: z.string().regex(/^[a-f0-9]{24}$/i),
      expectedVersion: z.coerce.number().int().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("PAY_RUN"),
      id: z.string().regex(/^[a-f0-9]{24}$/i),
      expectedVersion: z.coerce.number().int().min(1),
      paymentDate: z
        .string()
        .refine(isValidDateKey, "Choose a valid payment date."),
      paymentAccountCode: accountCodeSchema,
      paymentReference: z.string().trim().min(2).max(100),
    })
    .strict(),
]);

export type MalaysiaStatutoryAmounts = {
  epfEmployee: number;
  epfEmployer: number;
  socsoEmployee: number;
  socsoEmployer: number;
  eisEmployee: number;
  eisEmployer: number;
  pcb: number;
  zakat: number;
  cp38: number;
};

export function malaysiaStatutoryTotals(input: MalaysiaStatutoryAmounts) {
  return {
    employee: roundCurrency(
      input.epfEmployee +
        input.socsoEmployee +
        input.eisEmployee +
        input.pcb +
        input.zakat +
        input.cp38,
      "MYR",
    ),
    employer: roundCurrency(
      input.epfEmployer + input.socsoEmployer + input.eisEmployer,
      "MYR",
    ),
  };
}

export type PayrollProfileAmounts = {
  basePay: number;
  fixedAllowance: number;
  employeeDeduction: number;
  employerContribution: number;
  bonus?: number;
  overtimePay?: number;
  additionalDeduction?: number;
};

export function calculatePayrollAmounts(
  input: PayrollProfileAmounts,
  currency: string,
) {
  const supplied = {
    basePay: input.basePay,
    fixedAllowance: input.fixedAllowance,
    employeeDeduction: input.employeeDeduction,
    employerContribution: input.employerContribution,
    bonus: input.bonus ?? 0,
    overtimePay: input.overtimePay ?? 0,
    additionalDeduction: input.additionalDeduction ?? 0,
  };
  const rounded = Object.fromEntries(
    Object.entries(supplied).map(([key, value]) => [
      key,
      roundCurrency(value, currency),
    ]),
  ) as typeof supplied;
  for (const [key, value] of Object.entries(supplied)) {
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      Math.abs(value - rounded[key as keyof typeof supplied]) > 1e-8
    )
      throw new Error(`Use valid ${currency} precision for payroll amounts.`);
  }
  const grossPay = roundCurrency(
    rounded.basePay +
      rounded.fixedAllowance +
      rounded.bonus +
      rounded.overtimePay,
    currency,
  );
  const totalEmployeeDeduction = roundCurrency(
    rounded.employeeDeduction + rounded.additionalDeduction,
    currency,
  );
  if (totalEmployeeDeduction >= grossPay)
    throw new Error("Employee deductions must leave positive net pay.");
  const netPay = roundCurrency(grossPay - totalEmployeeDeduction, currency);
  const employerCost = roundCurrency(
    grossPay + rounded.employerContribution,
    currency,
  );
  return { ...rounded, grossPay, totalEmployeeDeduction, netPay, employerCost };
}

export function payrollRunTotals(
  employees: Array<{ amounts: ReturnType<typeof calculatePayrollAmounts> }>,
  currency: string,
) {
  return employees.reduce(
    (sum, employee) => {
      const deductions =
        employee.amounts.totalEmployeeDeduction ??
        employee.amounts.employeeDeduction;
      return {
        grossPay: roundCurrency(
          sum.grossPay + employee.amounts.grossPay,
          currency,
        ),
        employeeDeduction: roundCurrency(
          sum.employeeDeduction + deductions,
          currency,
        ),
        netPay: roundCurrency(sum.netPay + employee.amounts.netPay, currency),
        employerContribution: roundCurrency(
          sum.employerContribution + employee.amounts.employerContribution,
          currency,
        ),
        employerCost: roundCurrency(
          sum.employerCost + employee.amounts.employerCost,
          currency,
        ),
      };
    },
    {
      grossPay: 0,
      employeeDeduction: 0,
      netPay: 0,
      employerContribution: 0,
      employerCost: 0,
    },
  );
}

export function payrollJournalLines(run: {
  employees: Array<{
    amounts: ReturnType<typeof calculatePayrollAmounts>;
    accounts: Record<string, { code: string; name: string }>;
    statutory?: MalaysiaStatutoryAmounts;
  }>;
}) {
  const grouped = new Map<
    string,
    { accountCode: string; accountName: string; debit: number; credit: number }
  >();
  const add = (
    account: { code: string; name: string },
    debit: number,
    credit: number,
  ) => {
    if (!debit && !credit) return;
    const current = grouped.get(account.code) || {
      accountCode: account.code,
      accountName: account.name,
      debit: 0,
      credit: 0,
    };
    current.debit += debit;
    current.credit += credit;
    grouped.set(account.code, current);
  };
  for (const employee of run.employees) {
    const deductions =
      employee.amounts.totalEmployeeDeduction ??
      employee.amounts.employeeDeduction;
    const statutory = employee.statutory;
    const statutoryTotals = statutory
      ? malaysiaStatutoryTotals(statutory)
      : { employee: 0, employer: 0 };
    add(employee.accounts.wageExpense, employee.amounts.grossPay, 0);
    if (employee.amounts.employerContribution)
      add(
        employee.accounts.contributionExpense,
        employee.amounts.employerContribution,
        0,
      );
    add(employee.accounts.payrollPayable, 0, employee.amounts.netPay);
    const otherDeductions = Math.max(0, deductions - statutoryTotals.employee);
    const otherContributions = Math.max(
      0,
      employee.amounts.employerContribution - statutoryTotals.employer,
    );
    if (otherDeductions)
      add(employee.accounts.deductionPayable, 0, otherDeductions);
    if (otherContributions)
      add(employee.accounts.contributionPayable, 0, otherContributions);
    if (statutory) {
      add(
        employee.accounts.epfPayable,
        0,
        statutory.epfEmployee + statutory.epfEmployer,
      );
      add(
        employee.accounts.socsoPayable,
        0,
        statutory.socsoEmployee + statutory.socsoEmployer,
      );
      add(
        employee.accounts.eisPayable,
        0,
        statutory.eisEmployee + statutory.eisEmployer,
      );
      add(employee.accounts.pcbPayable, 0, statutory.pcb);
      add(employee.accounts.zakatPayable, 0, statutory.zakat + statutory.cp38);
    }
  }
  return [...grouped.values()];
}

export async function ensurePayrollAccounts(db: Db, session?: ClientSession) {
  const now = new Date();
  await db.collection("chartOfAccounts").bulkWrite(
    PAYROLL_ACCOUNTS.map((account) => ({
      updateOne: {
        filter: { code: account.code },
        update: { $setOnInsert: { ...account, active: true, createdAt: now } },
        upsert: true,
      },
    })),
    session ? { session } : undefined,
  );
}
