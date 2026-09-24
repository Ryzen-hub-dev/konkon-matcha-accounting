import assert from "node:assert/strict";
import test from "node:test";
import { prepareJournalAmounts } from "../lib/journals";
import {
  calculatePayrollAmounts,
  payrollJournalLines,
  payrollMutationSchema,
  payrollRunTotals,
  malaysiaStatutoryTotals,
} from "../lib/payroll";
import { hasPermission } from "../lib/rbac";

const accounts = {
  wageExpense: { code: "6110", name: "Wages and salaries" },
  contributionExpense: { code: "6120", name: "Employer contributions" },
  payrollPayable: { code: "2110", name: "Payroll payable" },
  deductionPayable: { code: "2120", name: "Payroll deductions payable" },
  contributionPayable: { code: "2130", name: "Employer contributions payable" },
  epfPayable: { code: "2140", name: "EPF payable" },
  socsoPayable: { code: "2150", name: "SOCSO payable" },
  eisPayable: { code: "2160", name: "EIS payable" },
  pcbPayable: { code: "2170", name: "PCB payable" },
  zakatPayable: { code: "2180", name: "Zakat and CP38 payable" },
};

test("payroll gross-to-net totals preserve currency precision and employer cost", () => {
  assert.deepEqual(
    calculatePayrollAmounts(
      {
        basePay: 3_000,
        fixedAllowance: 200,
        employeeDeduction: 350,
        employerContribution: 400,
      },
      "MYR",
    ),
    {
      basePay: 3_000,
      fixedAllowance: 200,
      employeeDeduction: 350,
      employerContribution: 400,
      bonus: 0,
      overtimePay: 0,
      additionalDeduction: 0,
      grossPay: 3_200,
      totalEmployeeDeduction: 350,
      netPay: 2_850,
      employerCost: 3_600,
    },
  );
  assert.throws(
    () =>
      calculatePayrollAmounts(
        {
          basePay: 100,
          fixedAllowance: 0,
          employeeDeduction: 100,
          employerContribution: 0,
        },
        "USD",
      ),
    /positive net pay/,
  );
  assert.throws(
    () =>
      calculatePayrollAmounts(
        {
          basePay: 100.5,
          fixedAllowance: 0,
          employeeDeduction: 0,
          employerContribution: 0,
        },
        "JPY",
      ),
    /precision/,
  );
});

test("Malaysia statutory review separates employee and employer liabilities", () => {
  const statutory = {
    epfEmployee: 330,
    epfEmployer: 390,
    socsoEmployee: 14.75,
    socsoEmployer: 51.65,
    eisEmployee: 5.9,
    eisEmployer: 5.9,
    pcb: 125,
    zakat: 20,
    cp38: 0,
  };
  assert.deepEqual(malaysiaStatutoryTotals(statutory), {
    employee: 495.65,
    employer: 447.55,
  });
  const journal = prepareJournalAmounts(
    payrollJournalLines({
      employees: [
        {
          amounts: calculatePayrollAmounts(
            {
              basePay: 3_000,
              fixedAllowance: 0,
              employeeDeduction: 545.65,
              employerContribution: 477.55,
            },
            "MYR",
          ),
          accounts,
          statutory,
        },
      ],
    }),
    "MYR",
  );
  assert.equal(journal.totalDebit, journal.totalCredit);
  assert.equal(
    journal.lines.find((line) => line.accountCode === "2140")?.credit,
    720,
  );
  assert.equal(
    journal.lines.find((line) => line.accountCode === "2170")?.credit,
    125,
  );
  assert.equal(
    journal.lines.find((line) => line.accountCode === "2120")?.credit,
    50,
  );
  assert.equal(
    payrollMutationSchema.safeParse({
      action: "SET_MALAYSIA_STATUTORY",
      id: "a".repeat(24),
      expectedVersion: 1,
      employeeNo: "MY-01",
      ...statutory,
      sourceReference: "LHDN/KWSP reviewed worksheet",
      confirmed: true,
    }).success,
    true,
  );
  assert.equal(
    payrollMutationSchema.safeParse({
      action: "SET_MALAYSIA_STATUTORY",
      id: "a".repeat(24),
      expectedVersion: 1,
      employeeNo: "MY-01",
      ...statutory,
      epfEmployee: 330.001,
      sourceReference: "Reviewed worksheet",
      confirmed: true,
    }).success,
    false,
  );
});

test("payroll adjustments recalculate run totals without changing frozen base terms", () => {
  const first = calculatePayrollAmounts(
    {
      basePay: 3_000,
      fixedAllowance: 200,
      employeeDeduction: 350,
      employerContribution: 400,
      bonus: 250,
      overtimePay: 100,
      additionalDeduction: 50,
    },
    "MYR",
  );
  const second = calculatePayrollAmounts(
    {
      basePay: 2_000,
      fixedAllowance: 0,
      employeeDeduction: 200,
      employerContribution: 250,
    },
    "MYR",
  );
  const { totalEmployeeDeduction: _legacyField, ...legacySecond } = second;
  assert.deepEqual(
    payrollRunTotals(
      [{ amounts: first }, { amounts: legacySecond as typeof second }],
      "MYR",
    ),
    {
      grossPay: 5_550,
      employeeDeduction: 600,
      netPay: 4_950,
      employerContribution: 650,
      employerCost: 6_200,
    },
  );
  assert.equal(first.basePay, 3_000);
  assert.equal(first.totalEmployeeDeduction, 400);
});

test("payroll accrual groups accounts and balances net pay, deductions and employer contributions", () => {
  const employees = [
    {
      amounts: calculatePayrollAmounts(
        {
          basePay: 3_000,
          fixedAllowance: 200,
          employeeDeduction: 350,
          employerContribution: 400,
        },
        "MYR",
      ),
      accounts,
    },
    {
      amounts: calculatePayrollAmounts(
        {
          basePay: 2_000,
          fixedAllowance: 0,
          employeeDeduction: 200,
          employerContribution: 250,
        },
        "MYR",
      ),
      accounts,
    },
  ];
  const journal = prepareJournalAmounts(
    payrollJournalLines({ employees }),
    "MYR",
  );
  assert.equal(journal.totalDebit, 5_850);
  assert.equal(journal.totalCredit, 5_850);
  assert.deepEqual(
    journal.lines.find((line) => line.accountCode === "2110"),
    {
      accountCode: "2110",
      accountName: "Payroll payable",
      debit: 0,
      credit: 4_650,
    },
  );
});

test("payroll mutations require valid calendar evidence and remain restricted to Owner/Admin", () => {
  assert.equal(
    payrollMutationSchema.safeParse({
      action: "CREATE_RUN",
      periodKey: "2026-13",
      payDate: "2026-09-30",
      clientRequestId: crypto.randomUUID(),
    }).success,
    false,
  );
  assert.equal(
    payrollMutationSchema.safeParse({
      action: "PAY_RUN",
      id: "a".repeat(24),
      expectedVersion: 1,
      paymentDate: "2026-02-30",
      paymentAccountCode: "1010",
      paymentReference: "BANK-1",
    }).success,
    false,
  );
  assert.equal(
    payrollMutationSchema.safeParse({
      action: "ADJUST_EMPLOYEE",
      id: "a".repeat(24),
      expectedVersion: 1,
      employeeNo: "E-1",
      bonus: 0,
      overtimePay: 0,
      additionalDeduction: 0,
      reason: "",
    }).success,
    false,
  );
  assert.equal(hasPermission("OWNER", "payroll.pay"), true);
  assert.equal(hasPermission("ADMIN", "payroll.approve"), true);
  assert.equal(hasPermission("MANAGER", "payroll.read"), false);
  assert.equal(hasPermission("ACCOUNTANT", "payroll.read"), false);
  assert.equal(hasPermission("CASHIER", "payroll.read"), false);
});
