"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  BadgeDollarSign,
  Banknote,
  CheckCircle2,
  Download,
  FileCheck2,
  Pencil,
  Plus,
  Printer,
  ShieldCheck,
  Users,
  WalletCards,
} from "lucide-react";
import {
  apiRequest,
  EmptyState,
  LoadingPanel,
  Modal,
  Notice,
  PageHeader,
  StatusPill,
  useNotice,
} from "@/components/ui";
import { COUNTRY_PROFILES } from "@/lib/international";

type Account = {
  code: string;
  name: string;
  type: "ASSET" | "EXPENSE" | "LIABILITY";
  cashEquivalent?: boolean;
};
type User = {
  _id: string;
  fullName: string;
  username: string;
  role: string;
  active: boolean;
};
type PayrollAccounts = Record<
  | "wageExpense"
  | "contributionExpense"
  | "payrollPayable"
  | "deductionPayable"
  | "contributionPayable"
  | "epfPayable"
  | "socsoPayable"
  | "eisPayable"
  | "pcbPayable"
  | "zakatPayable",
  { code: string; name: string }
>;
type Profile = {
  _id: string;
  userId: string;
  employeeNo: string;
  employeeName: string;
  countryCode: string;
  currency: string;
  effectiveFrom: string;
  active: boolean;
  basePay: number;
  fixedAllowance: number;
  employeeDeduction: number;
  employerContribution: number;
  deductionLabel: string;
  contributionLabel: string;
  accounts: PayrollAccounts;
  version: number;
};
type RunEmployee = {
  employeeNo: string;
  employeeName: string;
  countryCode: string;
  amounts: {
    basePay: number;
    fixedAllowance: number;
    bonus?: number;
    overtimePay?: number;
    grossPay: number;
    employeeDeduction: number;
    additionalDeduction?: number;
    totalEmployeeDeduction?: number;
    netPay: number;
    employerContribution: number;
    employerCost: number;
  };
  deductionLabel?: string;
  contributionLabel?: string;
  adjustmentReason?: string;
  adjustedByName?: string;
  statutory?: {
    epfEmployee: number;
    epfEmployer: number;
    socsoEmployee: number;
    socsoEmployer: number;
    eisEmployee: number;
    eisEmployer: number;
    pcb: number;
    zakat: number;
    cp38: number;
    sourceReference: string;
    confirmed: boolean;
    reviewedByName?: string;
  };
};
type Run = {
  _id: string;
  runNo: string;
  periodKey: string;
  payDate: string;
  currency: string;
  countryCodes: string[];
  employees: RunEmployee[];
  totals: {
    grossPay: number;
    employeeDeduction: number;
    netPay: number;
    employerContribution: number;
    employerCost: number;
  };
  status: string;
  version: number;
  createdByName: string;
  lastPreparedByName?: string;
  approvedByName?: string;
  paymentNo?: string;
  paymentReference?: string;
  statutoryReviewRequired?: boolean;
};
type PayrollData = {
  profiles: Profile[];
  runs: Run[];
  users: User[];
  accounts: Account[];
  currency: string;
  countryCode: string;
  business: { name: string; registrationNo: string; address: string };
  permissions: { approve: boolean; pay: boolean };
};

function csvCell(value: string | number) {
  const text = String(value);
  const safe = /^[\u0000-\u0020]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

function downloadPayrollCsv(run: Run) {
  const rows = [
    [
      "Run",
      "Period",
      "Pay date",
      "Status",
      "Employee no",
      "Employee",
      "Country",
      "Base pay",
      "Fixed allowance",
      "Bonus",
      "Overtime",
      "Gross pay",
      "Regular deductions",
      "Additional deduction",
      "Total deductions",
      "Net pay",
      "Employer contribution",
      "Employer cost",
    ],
    ...run.employees.map((employee) => [
      run.runNo,
      run.periodKey,
      run.payDate,
      run.status,
      employee.employeeNo,
      employee.employeeName,
      employee.countryCode,
      employee.amounts.basePay,
      employee.amounts.fixedAllowance,
      employee.amounts.bonus || 0,
      employee.amounts.overtimePay || 0,
      employee.amounts.grossPay,
      employee.amounts.employeeDeduction,
      employee.amounts.additionalDeduction || 0,
      employee.amounts.totalEmployeeDeduction ??
        employee.amounts.employeeDeduction,
      employee.amounts.netPay,
      employee.amounts.employerContribution,
      employee.amounts.employerCost,
    ]),
  ];
  const blob = new Blob(
    ["\uFEFF", rows.map((row) => row.map(csvCell).join(",")).join("\r\n")],
    { type: "text/csv;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${run.runNo}-${run.periodKey}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function PayrollView() {
  const [data, setData] = useState<PayrollData | null>(null);
  const [editing, setEditing] = useState<Profile | null | undefined>(undefined);
  const [creatingRun, setCreatingRun] = useState(false);
  const [paying, setPaying] = useState<Run | null>(null);
  const [adjusting, setAdjusting] = useState<{
    run: Run;
    employee: RunEmployee;
  } | null>(null);
  const [statutoryReview, setStatutoryReview] = useState<{
    run: Run;
    employee: RunEmployee;
  } | null>(null);
  const [payslip, setPayslip] = useState<{
    run: Run;
    employee: RunEmployee;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const { notice, show } = useNotice();
  const today = new Date().toISOString().slice(0, 10);

  async function load() {
    try {
      setData(await apiRequest<PayrollData>("/api/payroll"));
    } catch (reason) {
      show(
        reason instanceof Error ? reason.message : "Could not load payroll.",
        "error",
      );
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const money = useMemo(
    () =>
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: data?.currency || "USD",
      }),
    [data?.currency],
  );

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || busy) return;
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await apiRequest("/api/payroll", {
        method: "POST",
        body: JSON.stringify({
          action: "UPSERT_PROFILE",
          ...(editing
            ? { id: editing._id, expectedVersion: editing.version }
            : {}),
          userId: form.get("userId"),
          employeeNo: form.get("employeeNo"),
          countryCode: form.get("countryCode"),
          effectiveFrom: form.get("effectiveFrom"),
          active: form.has("active"),
          basePay: form.get("basePay"),
          fixedAllowance: form.get("fixedAllowance"),
          employeeDeduction: form.get("employeeDeduction"),
          employerContribution: form.get("employerContribution"),
          deductionLabel: form.get("deductionLabel"),
          contributionLabel: form.get("contributionLabel"),
          wageExpenseAccountCode: form.get("wageExpenseAccountCode"),
          contributionExpenseAccountCode: form.get(
            "contributionExpenseAccountCode",
          ),
          payrollPayableAccountCode: form.get("payrollPayableAccountCode"),
          deductionPayableAccountCode: form.get("deductionPayableAccountCode"),
          contributionPayableAccountCode: form.get(
            "contributionPayableAccountCode",
          ),
        }),
      });
      setEditing(undefined);
      show(editing ? "Payroll profile updated." : "Payroll profile added.");
      await load();
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not save payroll profile.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function createRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await apiRequest("/api/payroll", {
        method: "POST",
        body: JSON.stringify({
          action: "CREATE_RUN",
          periodKey: form.get("periodKey"),
          payDate: form.get("payDate"),
          clientRequestId: crypto.randomUUID(),
        }),
      });
      setCreatingRun(false);
      show("Draft payroll run created from active employee profiles.");
      await load();
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not create payroll run.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function runAction(run: Run, action: "APPROVE_RUN" | "POST_RUN") {
    if (busy) return;
    setBusy(true);
    try {
      await apiRequest("/api/payroll", {
        method: "POST",
        body: JSON.stringify({
          action,
          id: run._id,
          expectedVersion: run.version,
        }),
      });
      show(
        action === "APPROVE_RUN"
          ? "Payroll run approved."
          : "Payroll accrual posted to the ledger.",
      );
      await load();
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not update payroll run.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function adjustEmployee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!adjusting || busy) return;
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await apiRequest("/api/payroll", {
        method: "POST",
        body: JSON.stringify({
          action: "ADJUST_EMPLOYEE",
          id: adjusting.run._id,
          expectedVersion: adjusting.run.version,
          employeeNo: adjusting.employee.employeeNo,
          bonus: form.get("bonus"),
          overtimePay: form.get("overtimePay"),
          additionalDeduction: form.get("additionalDeduction"),
          reason: form.get("reason"),
        }),
      });
      setAdjusting(null);
      show("Employee pay adjusted. The run now requires independent approval.");
      await load();
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not adjust employee pay.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function payRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!paying || busy) return;
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await apiRequest("/api/payroll", {
        method: "POST",
        body: JSON.stringify({
          action: "PAY_RUN",
          id: paying._id,
          expectedVersion: paying.version,
          paymentDate: form.get("paymentDate"),
          paymentAccountCode: form.get("paymentAccountCode"),
          paymentReference: form.get("paymentReference"),
        }),
      });
      setPaying(null);
      show("Payroll payment posted and linked to the bank or cash account.");
      await load();
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not release payroll payment.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveStatutoryReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!statutoryReview || busy) return;
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      const amounts = Object.fromEntries(
        [
          "epfEmployee",
          "epfEmployer",
          "socsoEmployee",
          "socsoEmployer",
          "eisEmployee",
          "eisEmployer",
          "pcb",
          "zakat",
          "cp38",
        ].map((key) => [key, form.get(key)]),
      );
      await apiRequest("/api/payroll", {
        method: "POST",
        body: JSON.stringify({
          action: "SET_MALAYSIA_STATUTORY",
          id: statutoryReview.run._id,
          expectedVersion: statutoryReview.run.version,
          employeeNo: statutoryReview.employee.employeeNo,
          ...amounts,
          sourceReference: form.get("sourceReference"),
          confirmed: form.has("confirmed"),
        }),
      });
      setStatutoryReview(null);
      show("Malaysia statutory amounts reviewed and the run recalculated.");
      await load();
    } catch (reason) {
      show(
        reason instanceof Error
          ? reason.message
          : "Could not save the statutory review.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!data)
    return (
      <div className="page page-enter">
        <PageHeader
          eyebrow="PEOPLE LEDGER"
          title="Payroll"
          description="Loading protected payroll records."
        />
        {notice ? <Notice {...notice} /> : null}
        <LoadingPanel label="Preparing the pay desk…" />
      </div>
    );
  const expenseAccounts = data.accounts.filter(
    (account) => account.type === "EXPENSE",
  );
  const liabilityAccounts = data.accounts.filter(
    (account) => account.type === "LIABILITY",
  );
  const paymentAccounts = data.accounts.filter(
    (account) => account.type === "ASSET" && account.cashEquivalent,
  );
  const assigned = new Set(
    data.profiles
      .filter((profile) => profile._id !== editing?._id)
      .map((profile) => String(profile.userId)),
  );
  const eligibleUsers = data.users.filter((user) => !assigned.has(user._id));

  const accountField = (
    name: string,
    label: string,
    accounts: Account[],
    value: string,
  ) => (
    <label className="field">
      <span>{label}</span>
      <select name={name} defaultValue={value} required>
        {accounts.map((account) => (
          <option value={account.code} key={account.code}>
            {account.code} · {account.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="page page-enter payroll-page">
      <PageHeader
        eyebrow="PEOPLE LEDGER"
        title="Payroll"
        description="Monthly gross-to-net snapshots, maker-checker approval, accrual posting and controlled payment."
        action={
          <div className="page-actions">
            <button
              className="button button-secondary"
              onClick={() => setEditing(null)}
            >
              <Users />
              Add employee
            </button>
            <button
              className="button button-primary"
              onClick={() => setCreatingRun(true)}
            >
              <Plus />
              New pay run
            </button>
          </div>
        }
      />
      {notice ? <Notice {...notice} /> : null}
      <section className="payroll-policy">
        <ShieldCheck />
        <div>
          <strong>Country-aware, not country-assumed.</strong>
          <span>
            Each employee carries a country. Statutory deductions and employer
            contributions are entered as reviewed amounts until an
            authority-sourced, versioned country rule pack is installed.
          </span>
        </div>
      </section>
      <section className="payroll-summary">
        <article>
          <Users />
          <span>ACTIVE EMPLOYEES</span>
          <strong>
            {data.profiles.filter((profile) => profile.active).length}
          </strong>
        </article>
        <article>
          <BadgeDollarSign />
          <span>LATEST GROSS</span>
          <strong>{money.format(data.runs[0]?.totals.grossPay || 0)}</strong>
        </article>
        <article>
          <Banknote />
          <span>LATEST NET</span>
          <strong>{money.format(data.runs[0]?.totals.netPay || 0)}</strong>
        </article>
      </section>
      <div className="payroll-layout">
        <section className="panel payroll-run-register">
          <header>
            <div>
              <span className="eyebrow">MONTHLY CONTROL</span>
              <h2>Pay runs</h2>
            </div>
          </header>
          {data.runs.length ? (
            <div>
              {data.runs.map((run) => (
                <article className="payroll-run" key={run._id}>
                  <div>
                    <span>
                      {run.periodKey} · {run.runNo}
                    </span>
                    <strong>{money.format(run.totals.netPay)} net</strong>
                    <small>
                      {run.employees.length} employees ·{" "}
                      {run.countryCodes.join(" / ")} · pay {run.payDate}
                    </small>
                  </div>
                  <StatusPill value={run.status} />
                  <dl>
                    <div>
                      <dt>Gross</dt>
                      <dd>{money.format(run.totals.grossPay)}</dd>
                    </div>
                    <div>
                      <dt>Deductions</dt>
                      <dd>{money.format(run.totals.employeeDeduction)}</dd>
                    </div>
                    <div>
                      <dt>Employer cost</dt>
                      <dd>{money.format(run.totals.employerCost)}</dd>
                    </div>
                  </dl>
                  <details>
                    <summary>Review employee snapshot</summary>
                    {run.employees.map((employee) => (
                      <div
                        className="payroll-employee-line"
                        key={employee.employeeNo}
                      >
                        <span>
                          <strong>{employee.employeeName}</strong>
                          <small>
                            {employee.employeeNo} · {employee.countryCode}
                          </small>
                        </span>
                        <span>
                          Gross {money.format(employee.amounts.grossPay)}
                          {employee.amounts.bonus ||
                          employee.amounts.overtimePay ||
                          employee.amounts.additionalDeduction ? (
                            <small>
                              Adjusted
                              {employee.adjustmentReason
                                ? ` · ${employee.adjustmentReason}`
                                : ""}
                            </small>
                          ) : null}
                          {employee.countryCode === "MY" ? (
                            <small>
                              {employee.statutory?.confirmed
                                ? `Statutory reviewed${employee.statutory.reviewedByName ? ` · ${employee.statutory.reviewedByName}` : ""}`
                                : "Statutory review required"}
                            </small>
                          ) : null}
                        </span>
                        <b>Net {money.format(employee.amounts.netPay)}</b>
                        <span className="payroll-employee-actions">
                          <button
                            type="button"
                            className="button button-secondary"
                            onClick={() => setPayslip({ run, employee })}
                          >
                            <Printer />
                            Payslip
                          </button>
                          {run.status === "DRAFT" ? (
                            <>
                              {employee.countryCode === "MY" &&
                              run.currency === "MYR" ? (
                                <button
                                  type="button"
                                  className="button button-secondary"
                                  onClick={() =>
                                    setStatutoryReview({ run, employee })
                                  }
                                >
                                  <ShieldCheck />
                                  {employee.statutory?.confirmed
                                    ? "Review statutory"
                                    : "Set statutory"}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="button button-secondary"
                                onClick={() => setAdjusting({ run, employee })}
                              >
                                <Pencil />
                                Adjust
                              </button>
                            </>
                          ) : null}
                        </span>
                      </div>
                    ))}
                  </details>
                  <footer>
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => downloadPayrollCsv(run)}
                    >
                      <Download />
                      Export CSV
                    </button>
                    {run.status === "DRAFT" && data.permissions.approve ? (
                      <button
                        className="button button-primary"
                        disabled={busy}
                        onClick={() => void runAction(run, "APPROVE_RUN")}
                      >
                        <CheckCircle2 />
                        Approve
                      </button>
                    ) : null}
                    {run.status === "APPROVED" && data.permissions.approve ? (
                      <button
                        className="button button-primary"
                        disabled={busy}
                        onClick={() => void runAction(run, "POST_RUN")}
                      >
                        <FileCheck2 />
                        Post accrual
                      </button>
                    ) : null}
                    {run.status === "POSTED" && data.permissions.pay ? (
                      <button
                        className="button button-primary"
                        disabled={busy}
                        onClick={() => setPaying(run)}
                      >
                        <WalletCards />
                        Release payment
                      </button>
                    ) : null}
                    {run.status === "PAID" ? (
                      <small>
                        Payment {run.paymentNo} · {run.paymentReference}
                      </small>
                    ) : (
                      <small>
                        Created by {run.createdByName}
                        {run.approvedByName
                          ? ` · approved by ${run.approvedByName}`
                          : ""}
                      </small>
                    )}
                  </footer>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No pay runs"
              detail="Add an employee payroll profile, then create the first monthly run."
            />
          )}
        </section>
        <aside className="panel payroll-profile-register">
          <header>
            <span className="eyebrow">EMPLOYEE TERMS</span>
            <h2>Payroll profiles</h2>
          </header>
          {data.profiles.length ? (
            data.profiles.map((profile) => (
              <button
                key={profile._id}
                className="payroll-profile-row"
                onClick={() => setEditing(profile)}
              >
                <span>
                  <strong>{profile.employeeName}</strong>
                  <small>
                    {profile.employeeNo} · {profile.countryCode} ·{" "}
                    {profile.active ? "Active" : "Inactive"}
                  </small>
                </span>
                <b>{money.format(profile.basePay + profile.fixedAllowance)}</b>
              </button>
            ))
          ) : (
            <p>No payroll profiles yet.</p>
          )}
        </aside>
      </div>

      <Modal
        open={editing !== undefined}
        onClose={() => {
          if (!busy) setEditing(undefined);
        }}
        title={editing ? "Edit payroll profile" : "Add payroll employee"}
        kicker="MONTHLY TERMS"
      >
        <form
          className="modal-form wide-form payroll-profile-form"
          onSubmit={saveProfile}
        >
          <fieldset disabled={busy}>
            <div className="form-grid three">
              <label className="field">
                <span>Team account</span>
                <select
                  name="userId"
                  defaultValue={String(editing?.userId || "")}
                  required
                >
                  <option value="" disabled>
                    Select employee
                  </option>
                  {eligibleUsers.map((user) => (
                    <option value={user._id} key={user._id}>
                      {user.fullName} · {user.role}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Employee number</span>
                <input
                  name="employeeNo"
                  defaultValue={editing?.employeeNo}
                  minLength={2}
                  maxLength={30}
                  pattern="[A-Za-z0-9_-]+"
                  required
                />
              </label>
              <label className="field">
                <span>Employment country</span>
                <select
                  name="countryCode"
                  defaultValue={editing?.countryCode || data.countryCode}
                >
                  {COUNTRY_PROFILES.map((country) => (
                    <option value={country.code} key={country.code}>
                      {country.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Effective from</span>
                <input
                  name="effectiveFrom"
                  type="date"
                  defaultValue={editing?.effectiveFrom || today}
                  required
                />
              </label>
              <label className="check-row compact">
                <input
                  name="active"
                  type="checkbox"
                  defaultChecked={editing?.active ?? true}
                />
                <span>Active for new pay runs</span>
              </label>
            </div>
            <div className="form-grid four">
              <label className="field">
                <span>Base pay · {data.currency}</span>
                <input
                  name="basePay"
                  type="number"
                  min="0.01"
                  step="any"
                  defaultValue={editing?.basePay || 0}
                  required
                />
              </label>
              <label className="field">
                <span>Fixed allowance</span>
                <input
                  name="fixedAllowance"
                  type="number"
                  min="0"
                  step="any"
                  defaultValue={editing?.fixedAllowance || 0}
                  required
                />
              </label>
              <label className="field">
                <span>Employee deductions</span>
                <input
                  name="employeeDeduction"
                  type="number"
                  min="0"
                  step="any"
                  defaultValue={editing?.employeeDeduction || 0}
                  required
                />
              </label>
              <label className="field">
                <span>Employer contributions</span>
                <input
                  name="employerContribution"
                  type="number"
                  min="0"
                  step="any"
                  defaultValue={editing?.employerContribution || 0}
                  required
                />
              </label>
            </div>
            <div className="form-grid two">
              <label className="field">
                <span>Deduction label</span>
                <input
                  name="deductionLabel"
                  defaultValue={
                    editing?.deductionLabel || "Employee deductions"
                  }
                  maxLength={80}
                />
              </label>
              <label className="field">
                <span>Contribution label</span>
                <input
                  name="contributionLabel"
                  defaultValue={
                    editing?.contributionLabel || "Employer contributions"
                  }
                  maxLength={80}
                />
              </label>
            </div>
            <div className="settings-divider" />
            <div className="form-grid two">
              {accountField(
                "wageExpenseAccountCode",
                "Wage expense",
                expenseAccounts,
                editing?.accounts.wageExpense.code || "6110",
              )}
              {accountField(
                "contributionExpenseAccountCode",
                "Employer contribution expense",
                expenseAccounts,
                editing?.accounts.contributionExpense.code || "6120",
              )}
              {accountField(
                "payrollPayableAccountCode",
                "Net payroll payable",
                liabilityAccounts,
                editing?.accounts.payrollPayable.code || "2110",
              )}
              {accountField(
                "deductionPayableAccountCode",
                "Employee deductions payable",
                liabilityAccounts,
                editing?.accounts.deductionPayable.code || "2120",
              )}
              {accountField(
                "contributionPayableAccountCode",
                "Employer contributions payable",
                liabilityAccounts,
                editing?.accounts.contributionPayable.code || "2130",
              )}
            </div>
          </fieldset>
          <footer>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => setEditing(undefined)}
            >
              Cancel
            </button>
            <button
              className="button button-primary"
              disabled={busy || !eligibleUsers.length}
            >
              {busy ? "Saving…" : "Save payroll profile"}
            </button>
          </footer>
        </form>
      </Modal>
      <Modal
        open={creatingRun}
        onClose={() => {
          if (!busy) setCreatingRun(false);
        }}
        title="Create monthly pay run"
        kicker="FROZEN SNAPSHOT"
      >
        <form className="modal-form" onSubmit={createRun}>
          <div className="form-grid two">
            <label className="field">
              <span>Payroll month</span>
              <input
                name="periodKey"
                type="month"
                defaultValue={today.slice(0, 7)}
                required
              />
            </label>
            <label className="field">
              <span>Pay date</span>
              <input name="payDate" type="date" defaultValue={today} required />
            </label>
          </div>
          <p className="form-hint">
            Every active profile effective by the pay date is copied into an
            immutable draft snapshot. Later profile changes do not rewrite this
            run.
          </p>
          <footer>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setCreatingRun(false)}
            >
              Cancel
            </button>
            <button
              className="button button-primary"
              disabled={
                busy || !data.profiles.some((profile) => profile.active)
              }
            >
              {busy ? "Creating…" : "Create draft run"}
            </button>
          </footer>
        </form>
      </Modal>
      <Modal
        open={Boolean(adjusting)}
        onClose={() => {
          if (!busy) setAdjusting(null);
        }}
        title="Adjust draft pay"
        kicker="REVIEWED VARIANCE"
      >
        {adjusting ? (
          <form className="modal-form" onSubmit={adjustEmployee}>
            <div className="payroll-adjustment-subject">
              <span>
                {adjusting.employee.employeeNo} ·{" "}
                {adjusting.employee.countryCode}
              </span>
              <strong>{adjusting.employee.employeeName}</strong>
              <small>
                Base and fixed terms remain frozen from the payroll profile.
              </small>
            </div>
            <fieldset disabled={busy}>
              <div className="form-grid three">
                <label className="field">
                  <span>Bonus · {adjusting.run.currency}</span>
                  <input
                    name="bonus"
                    type="number"
                    min="0"
                    step="any"
                    defaultValue={adjusting.employee.amounts.bonus || 0}
                    required
                  />
                </label>
                <label className="field">
                  <span>Overtime pay</span>
                  <input
                    name="overtimePay"
                    type="number"
                    min="0"
                    step="any"
                    defaultValue={adjusting.employee.amounts.overtimePay || 0}
                    required
                  />
                </label>
                <label className="field">
                  <span>Additional deduction</span>
                  <input
                    name="additionalDeduction"
                    type="number"
                    min="0"
                    step="any"
                    defaultValue={
                      adjusting.employee.amounts.additionalDeduction || 0
                    }
                    required
                  />
                </label>
              </div>
              <label className="field">
                <span>Reason for this adjustment</span>
                <textarea
                  name="reason"
                  minLength={3}
                  maxLength={300}
                  placeholder="For example: approved September overtime"
                  required
                />
              </label>
            </fieldset>
            <p className="form-hint">
              Saving recalculates gross pay, deductions, net pay and the future
              accounting entry. For Malaysia employees it also clears the
              statutory confirmation so EPF, SOCSO, EIS and PCB can be reviewed
              against the updated remuneration. A non-owner preparer cannot
              approve their own latest adjustment.
            </p>
            <footer>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => setAdjusting(null)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? "Recalculating…" : "Save adjustment"}
              </button>
            </footer>
          </form>
        ) : null}
      </Modal>
      <Modal
        open={Boolean(statutoryReview)}
        onClose={() => {
          if (!busy) setStatutoryReview(null);
        }}
        title="Malaysia statutory review"
        kicker="EPF · SOCSO · EIS · PCB"
      >
        {statutoryReview ? (
          <form className="modal-form wide-form" onSubmit={saveStatutoryReview}>
            <div className="payroll-adjustment-subject">
              <span>
                {statutoryReview.employee.employeeNo} · pay period{" "}
                {statutoryReview.run.periodKey}
              </span>
              <strong>{statutoryReview.employee.employeeName}</strong>
              <small>
                Enter the reviewed monthly values from the current official
                schedules or your approved payroll calculation source.
              </small>
            </div>
            <fieldset disabled={busy}>
              <div className="form-grid three">
                {[
                  ["epfEmployee", "EPF · employee"],
                  ["epfEmployer", "EPF · employer"],
                  ["socsoEmployee", "SOCSO · employee"],
                  ["socsoEmployer", "SOCSO · employer"],
                  ["eisEmployee", "EIS · employee"],
                  ["eisEmployer", "EIS · employer"],
                  ["pcb", "PCB / MTD"],
                  ["zakat", "Zakat payroll deduction"],
                  ["cp38", "CP38 additional deduction"],
                ].map(([name, label]) => (
                  <label className="field" key={name}>
                    <span>{label} · MYR</span>
                    <input
                      name={name}
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={
                        statutoryReview.employee.statutory?.[
                          name as keyof NonNullable<RunEmployee["statutory"]>
                        ] as number | undefined
                      }
                      required
                    />
                  </label>
                ))}
              </div>
              <label className="field">
                <span>Calculation source / reference</span>
                <input
                  name="sourceReference"
                  minLength={3}
                  maxLength={200}
                  defaultValue={
                    statutoryReview.employee.statutory?.sourceReference || ""
                  }
                  placeholder="Official schedule, payroll worksheet or provider reference"
                  required
                />
              </label>
              <label className="check-row">
                <input name="confirmed" type="checkbox" required />
                <span>
                  I reviewed these values for this employee and pay period.
                </span>
              </label>
            </fieldset>
            <p className="form-hint">
              Approval is blocked until every Malaysia employee in a MYR run has
              a confirmed review. This workflow records exact liabilities
              without pretending that an unverified tax calculator is official.
            </p>
            <footer>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => setStatutoryReview(null)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? "Recalculating…" : "Confirm statutory amounts"}
              </button>
            </footer>
          </form>
        ) : null}
      </Modal>
      <Modal
        open={Boolean(payslip)}
        onClose={() => setPayslip(null)}
        title="Employee payslip"
        kicker="PRINT / SAVE AS PDF"
      >
        {payslip ? (
          <div className="payroll-payslip">
            <header>
              <div>
                <span>PAYSLIP · {payslip.run.periodKey}</span>
                <h2>{data.business.name}</h2>
                <p>
                  {[data.business.registrationNo, data.business.address]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <StatusPill value={payslip.run.status} />
            </header>
            <section className="payroll-payslip-identity">
              <div>
                <span>Employee</span>
                <strong>{payslip.employee.employeeName}</strong>
                <small>
                  {payslip.employee.employeeNo} · {payslip.employee.countryCode}
                </small>
              </div>
              <div>
                <span>Pay date</span>
                <strong>{payslip.run.payDate}</strong>
                <small>{payslip.run.runNo}</small>
              </div>
            </section>
            <section className="payroll-payslip-lines">
              <div>
                <span>Base pay</span>
                <b>{money.format(payslip.employee.amounts.basePay)}</b>
              </div>
              <div>
                <span>Fixed allowance</span>
                <b>{money.format(payslip.employee.amounts.fixedAllowance)}</b>
              </div>
              {payslip.employee.amounts.bonus ? (
                <div>
                  <span>Bonus</span>
                  <b>{money.format(payslip.employee.amounts.bonus)}</b>
                </div>
              ) : null}
              {payslip.employee.amounts.overtimePay ? (
                <div>
                  <span>Overtime pay</span>
                  <b>{money.format(payslip.employee.amounts.overtimePay)}</b>
                </div>
              ) : null}
              <div className="payroll-payslip-subtotal">
                <span>Gross pay</span>
                <b>{money.format(payslip.employee.amounts.grossPay)}</b>
              </div>
              <div>
                <span>
                  {payslip.employee.deductionLabel || "Employee deductions"}
                </span>
                <b>
                  -{money.format(payslip.employee.amounts.employeeDeduction)}
                </b>
              </div>
              {payslip.employee.statutory ? (
                <>
                  <div>
                    <span>EPF · employee / employer</span>
                    <b>
                      {money.format(payslip.employee.statutory.epfEmployee)} /{" "}
                      {money.format(payslip.employee.statutory.epfEmployer)}
                    </b>
                  </div>
                  <div>
                    <span>SOCSO · employee / employer</span>
                    <b>
                      {money.format(payslip.employee.statutory.socsoEmployee)} /{" "}
                      {money.format(payslip.employee.statutory.socsoEmployer)}
                    </b>
                  </div>
                  <div>
                    <span>EIS · employee / employer</span>
                    <b>
                      {money.format(payslip.employee.statutory.eisEmployee)} /{" "}
                      {money.format(payslip.employee.statutory.eisEmployer)}
                    </b>
                  </div>
                  <div>
                    <span>PCB / Zakat / CP38</span>
                    <b>
                      {money.format(payslip.employee.statutory.pcb)} /{" "}
                      {money.format(payslip.employee.statutory.zakat)} /{" "}
                      {money.format(payslip.employee.statutory.cp38)}
                    </b>
                  </div>
                </>
              ) : null}
              {payslip.employee.amounts.additionalDeduction ? (
                <div>
                  <span>Additional deduction</span>
                  <b>
                    -
                    {money.format(payslip.employee.amounts.additionalDeduction)}
                  </b>
                </div>
              ) : null}
              <div className="payroll-payslip-net">
                <span>Net pay</span>
                <b>{money.format(payslip.employee.amounts.netPay)}</b>
              </div>
              <div>
                <span>
                  {payslip.employee.contributionLabel ||
                    "Employer contributions"}
                </span>
                <b>
                  {money.format(payslip.employee.amounts.employerContribution)}
                </b>
              </div>
            </section>
            {payslip.employee.adjustmentReason ? (
              <p className="payroll-payslip-note">
                Adjustment: {payslip.employee.adjustmentReason}
              </p>
            ) : null}
            {payslip.employee.statutory?.sourceReference ? (
              <p className="payroll-payslip-note">
                Statutory review source:{" "}
                {payslip.employee.statutory.sourceReference}
              </p>
            ) : null}
            <footer>
              <p>
                This payslip reflects reviewed payroll inputs. Country-specific
                statutory filing remains subject to the configured authority
                workflow.
              </p>
              <button
                type="button"
                className="button button-primary payroll-payslip-print"
                onClick={() => window.print()}
              >
                <Printer />
                Print / save PDF
              </button>
            </footer>
          </div>
        ) : null}
      </Modal>
      <Modal
        open={Boolean(paying)}
        onClose={() => {
          if (!busy) setPaying(null);
        }}
        title="Release payroll payment"
        kicker="BANK / CASH POSTING"
      >
        {paying ? (
          <form className="modal-form" onSubmit={payRun}>
            <div className="payroll-payment-total">
              <span>Net payroll</span>
              <strong>{money.format(paying.totals.netPay)}</strong>
            </div>
            <div className="form-grid two">
              <label className="field">
                <span>Payment date</span>
                <input
                  name="paymentDate"
                  type="date"
                  defaultValue={today}
                  required
                />
              </label>
              <label className="field">
                <span>Paid from</span>
                <select name="paymentAccountCode" required>
                  {paymentAccounts.map((account) => (
                    <option key={account.code} value={account.code}>
                      {account.code} · {account.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>Bank or payment reference</span>
              <input
                name="paymentReference"
                minLength={2}
                maxLength={100}
                required
              />
            </label>
            <p className="form-hint">
              This posts net payroll payable against the selected cash or bank
              account. Statutory liabilities remain outstanding until remitted
              separately.
            </p>
            <footer>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setPaying(null)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                disabled={busy || !paymentAccounts.length}
              >
                {busy ? "Posting…" : "Post payment"}
              </button>
            </footer>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}
