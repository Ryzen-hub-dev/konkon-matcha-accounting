import { ObjectId, type Db } from "mongodb";
import {
  authorize,
  created,
  fail,
  ok,
  publicError,
  sameOrigin,
} from "@/lib/api";
import { writeAudit } from "@/lib/audit";
import { AccountingPeriodClosedError } from "@/lib/accounting-periods";
import { assertAccountingPeriodOpen } from "@/lib/accounting-period-lock";
import { normaliseBusinessSettings } from "@/lib/business-settings";
import { getDb, getMongoClient } from "@/lib/db";
import { makeDocumentNo, serialise } from "@/lib/format";
import { roundCurrency } from "@/lib/international";
import { prepareJournalAmounts } from "@/lib/journals";
import {
  calculatePayrollAmounts,
  ensurePayrollAccounts,
  payrollJournalLines,
  payrollMutationSchema,
  payrollRunTotals,
} from "@/lib/payroll";
import { hasPermission } from "@/lib/rbac";
export const runtime = "nodejs";
export const maxDuration = 30;

class PayrollConflict extends Error {}

const accountFields = [
  ["wageExpenseAccountCode", "wageExpense", "EXPENSE"],
  ["contributionExpenseAccountCode", "contributionExpense", "EXPENSE"],
  ["payrollPayableAccountCode", "payrollPayable", "LIABILITY"],
  ["deductionPayableAccountCode", "deductionPayable", "LIABILITY"],
  ["contributionPayableAccountCode", "contributionPayable", "LIABILITY"],
  ["epfPayableAccountCode", "epfPayable", "LIABILITY"],
  ["socsoPayableAccountCode", "socsoPayable", "LIABILITY"],
  ["eisPayableAccountCode", "eisPayable", "LIABILITY"],
  ["pcbPayableAccountCode", "pcbPayable", "LIABILITY"],
  ["zakatPayableAccountCode", "zakatPayable", "LIABILITY"],
] as const;

async function profileAccounts(db: Db, input: Record<string, unknown>) {
  const codes = accountFields.map(([field]) => String(input[field]));
  const accounts = await db
    .collection("chartOfAccounts")
    .find({ code: { $in: codes }, active: { $ne: false } })
    .toArray();
  const result: Record<string, { code: string; name: string }> = {};
  for (const [field, key, type] of accountFields) {
    const account = accounts.find(
      (item) => item.code === input[field] && item.type === type,
    );
    if (!account)
      throw new Error(
        `Choose an active ${type.toLowerCase()} account for ${String(field).replace("AccountCode", "")}.`,
      );
    result[key] = { code: String(account.code), name: String(account.name) };
  }
  return result;
}

export async function GET() {
  const auth = await authorize("payroll.read");
  if (auth.error) return auth.error;
  try {
    const db = await getDb();
    await ensurePayrollAccounts(db);
    const [profiles, runs, users, accounts, settings] = await Promise.all([
      db
        .collection("payrollProfiles")
        .find({})
        .sort({ active: -1, employeeNo: 1 })
        .limit(500)
        .toArray(),
      db
        .collection("payrollRuns")
        .find({})
        .sort({ periodKey: -1, createdAt: -1 })
        .limit(36)
        .toArray(),
      db
        .collection("users")
        .find(
          { archivedAt: { $exists: false } },
          { projection: { fullName: 1, username: 1, role: 1, active: 1 } },
        )
        .sort({ fullName: 1 })
        .toArray(),
      db
        .collection("chartOfAccounts")
        .find({
          active: { $ne: false },
          type: { $in: ["ASSET", "EXPENSE", "LIABILITY"] },
        })
        .project({ code: 1, name: 1, type: 1, cashEquivalent: 1 })
        .sort({ code: 1 })
        .toArray(),
      db.collection("settings").findOne({ key: "business" }),
    ]);
    const business = normaliseBusinessSettings(settings);
    return ok(
      serialise({
        profiles,
        runs,
        users,
        accounts,
        currency: business.currency,
        countryCode: business.countryCode,
        business: {
          name: business.businessName,
          registrationNo: business.registrationNo,
          address: business.address,
        },
        permissions: {
          approve: hasPermission(auth.session.role, "payroll.approve"),
          pay: hasPermission(auth.session.role, "payroll.pay"),
        },
      }),
    );
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: Request) {
  const auth = await authorize("payroll.write");
  if (auth.error) return auth.error;
  if (!sameOrigin(request)) return fail("This request was blocked.", 403);
  try {
    const input = payrollMutationSchema.safeParse(await request.json());
    if (!input.success)
      return fail(
        "Check the payroll details.",
        422,
        input.error.flatten().fieldErrors,
      );
    if (
      ["APPROVE_RUN", "POST_RUN"].includes(input.data.action) &&
      !hasPermission(auth.session.role, "payroll.approve")
    )
      return fail("You cannot approve or post payroll.", 403);
    if (
      input.data.action === "PAY_RUN" &&
      !hasPermission(auth.session.role, "payroll.pay")
    )
      return fail("You cannot release payroll payment.", 403);
    const db = await getDb();
    const business = normaliseBusinessSettings(
      await db.collection("settings").findOne({ key: "business" }),
    );
    await ensurePayrollAccounts(db);

    if (input.data.action === "UPSERT_PROFILE") {
      const user = await db.collection("users").findOne(
        {
          _id: new ObjectId(input.data.userId),
          archivedAt: { $exists: false },
        },
        { projection: { fullName: 1, username: 1, active: 1 } },
      );
      if (!user) return fail("Choose an existing team account.", 422);
      if (input.data.active && user.active !== true)
        return fail(
          "Enable the team account before activating its payroll profile.",
          409,
        );
      const amounts = calculatePayrollAmounts(input.data, business.currency);
      const accounts = await profileAccounts(db, input.data);
      const now = new Date();
      const document = {
        userId: user._id,
        employeeNo: input.data.employeeNo,
        employeeName: String(user.fullName),
        countryCode: input.data.countryCode,
        currency: business.currency,
        payFrequency: "MONTHLY",
        effectiveFrom: input.data.effectiveFrom,
        active: input.data.active,
        ...amounts,
        deductionLabel: input.data.deductionLabel || "Employee deductions",
        contributionLabel:
          input.data.contributionLabel || "Employer contributions",
        accounts,
        updatedBy: new ObjectId(auth.session.id),
        updatedAt: now,
      };
      if (input.data.id) {
        const profile = await db.collection("payrollProfiles").findOneAndUpdate(
          {
            _id: new ObjectId(input.data.id),
            version: input.data.expectedVersion,
          },
          { $set: document, $inc: { version: 1 } },
          { returnDocument: "after" },
        );
        if (!profile)
          return fail(
            "This payroll profile changed. Reload and try again.",
            409,
          );
        await writeAudit(
          db,
          auth.session,
          "payroll.profile_update",
          "payrollProfile",
          input.data.id,
          { employeeNo: document.employeeNo, active: document.active },
        );
        return ok(serialise(profile));
      }
      const result = await db.collection("payrollProfiles").insertOne({
        ...document,
        version: 1,
        createdBy: new ObjectId(auth.session.id),
        createdAt: now,
      });
      await writeAudit(
        db,
        auth.session,
        "payroll.profile_create",
        "payrollProfile",
        result.insertedId.toHexString(),
        { employeeNo: document.employeeNo, countryCode: document.countryCode },
      );
      return created(
        serialise({ _id: result.insertedId, ...document, version: 1 }),
      );
    }

    if (input.data.action === "CREATE_RUN") {
      const retry = await db
        .collection("payrollRuns")
        .findOne({ clientRequestId: input.data.clientRequestId });
      if (retry) return ok(serialise(retry));
      if (
        await db
          .collection("payrollRuns")
          .findOne({ periodKey: input.data.periodKey })
      )
        return fail("A payroll run already exists for this month.", 409);
      const users = await db
        .collection("users")
        .find(
          { active: true, archivedAt: { $exists: false } },
          { projection: { fullName: 1 } },
        )
        .toArray();
      const userMap = new Map(
        users.map((user) => [String(user._id), String(user.fullName)]),
      );
      const profiles = (
        await db
          .collection("payrollProfiles")
          .find({ active: true, effectiveFrom: { $lte: input.data.payDate } })
          .sort({ employeeNo: 1 })
          .toArray()
      ).filter((profile) => userMap.has(String(profile.userId)));
      if (!profiles.length)
        return fail(
          "Add at least one active payroll profile before creating a run.",
          409,
        );
      const employees = profiles.map((profile) => ({
        profileId: profile._id,
        profileVersion: profile.version,
        userId: profile.userId,
        employeeNo: profile.employeeNo,
        employeeName: userMap.get(String(profile.userId)),
        countryCode: profile.countryCode,
        amounts: calculatePayrollAmounts(profile as never, business.currency),
        payTerms: {
          employeeDeduction: Number(profile.employeeDeduction || 0),
          employerContribution: Number(profile.employerContribution || 0),
        },
        deductionLabel: profile.deductionLabel,
        contributionLabel: profile.contributionLabel,
        accounts: {
          ...profile.accounts,
          epfPayable: profile.accounts?.epfPayable || {
            code: "2140",
            name: "EPF payable",
          },
          socsoPayable: profile.accounts?.socsoPayable || {
            code: "2150",
            name: "SOCSO payable",
          },
          eisPayable: profile.accounts?.eisPayable || {
            code: "2160",
            name: "EIS payable",
          },
          pcbPayable: profile.accounts?.pcbPayable || {
            code: "2170",
            name: "PCB payable",
          },
          zakatPayable: profile.accounts?.zakatPayable || {
            code: "2180",
            name: "Zakat and CP38 payable",
          },
        },
      }));
      const totals = payrollRunTotals(employees, business.currency);
      const now = new Date();
      const document = {
        runNo: makeDocumentNo("PAY"),
        periodKey: input.data.periodKey,
        payDate: input.data.payDate,
        clientRequestId: input.data.clientRequestId,
        currency: business.currency,
        countryCodes: [
          ...new Set(employees.map((employee) => employee.countryCode)),
        ],
        statutoryReviewRequired:
          business.currency === "MYR" &&
          employees.some((employee) => employee.countryCode === "MY"),
        employees,
        totals,
        status: "DRAFT",
        version: 1,
        createdBy: new ObjectId(auth.session.id),
        createdByName: auth.session.fullName,
        lastPreparedBy: new ObjectId(auth.session.id),
        lastPreparedByName: auth.session.fullName,
        createdAt: now,
        updatedAt: now,
      };
      const result = await db.collection("payrollRuns").insertOne(document);
      await writeAudit(
        db,
        auth.session,
        "payroll.run_create",
        "payrollRun",
        result.insertedId.toHexString(),
        {
          runNo: document.runNo,
          periodKey: document.periodKey,
          employeeCount: employees.length,
        },
      );
      return created(serialise({ _id: result.insertedId, ...document }));
    }

    if (
      input.data.action !== "ADJUST_EMPLOYEE" &&
      input.data.action !== "SET_MALAYSIA_STATUTORY" &&
      input.data.action !== "APPROVE_RUN" &&
      input.data.action !== "POST_RUN" &&
      input.data.action !== "PAY_RUN"
    )
      return fail("Choose a payroll run action.", 422);
    const runInput = input.data;
    const runId = new ObjectId(runInput.id);
    const run = await db.collection("payrollRuns").findOne({ _id: runId });
    if (!run) return fail("This payroll run no longer exists.", 404);
    if (run.version !== runInput.expectedVersion)
      return fail("This payroll run changed. Reload and try again.", 409);

    if (runInput.action === "ADJUST_EMPLOYEE") {
      if (run.status !== "DRAFT")
        return fail("Only a draft payroll run can be adjusted.", 409);
      const employees = (run.employees as Array<Record<string, unknown>>).map(
        (employee) => {
          if (employee.employeeNo !== runInput.employeeNo) return employee;
          const current = employee.amounts as ReturnType<
            typeof calculatePayrollAmounts
          >;
          const statutory = employee.statutory as
            Record<string, number> | undefined;
          const statutoryEmployee = statutory
            ? Number(statutory.epfEmployee || 0) +
              Number(statutory.socsoEmployee || 0) +
              Number(statutory.eisEmployee || 0) +
              Number(statutory.pcb || 0) +
              Number(statutory.zakat || 0) +
              Number(statutory.cp38 || 0)
            : 0;
          const statutoryEmployer = statutory
            ? Number(statutory.epfEmployer || 0) +
              Number(statutory.socsoEmployer || 0) +
              Number(statutory.eisEmployer || 0)
            : 0;
          const payTerms = (employee.payTerms || {}) as Record<string, number>;
          const baseEmployeeDeduction = Number(
            payTerms.employeeDeduction ??
              Math.max(0, current.employeeDeduction - statutoryEmployee),
          );
          const baseEmployerContribution = Number(
            payTerms.employerContribution ??
              Math.max(0, current.employerContribution - statutoryEmployer),
          );
          const { statutory: _statutory, ...employeeWithoutStatutory } =
            employee;
          return {
            ...employeeWithoutStatutory,
            amounts: calculatePayrollAmounts(
              {
                basePay: current.basePay,
                fixedAllowance: current.fixedAllowance,
                employeeDeduction: baseEmployeeDeduction,
                employerContribution: baseEmployerContribution,
                bonus: runInput.bonus,
                overtimePay: runInput.overtimePay,
                additionalDeduction: runInput.additionalDeduction,
              },
              business.currency,
            ),
            payTerms: {
              employeeDeduction: baseEmployeeDeduction,
              employerContribution: baseEmployerContribution,
            },
            adjustmentReason: runInput.reason,
            adjustedByName: auth.session.fullName,
            adjustedAt: new Date(),
          };
        },
      );
      if (
        !employees.some(
          (employee) => employee.employeeNo === runInput.employeeNo,
        )
      )
        return fail("This employee is not in the payroll run.", 404);
      const totals = payrollRunTotals(
        employees as Array<{
          amounts: ReturnType<typeof calculatePayrollAmounts>;
        }>,
        business.currency,
      );
      const updated = await db.collection("payrollRuns").findOneAndUpdate(
        { _id: runId, status: "DRAFT", version: runInput.expectedVersion },
        {
          $set: {
            employees,
            totals,
            lastPreparedBy: new ObjectId(auth.session.id),
            lastPreparedByName: auth.session.fullName,
            updatedAt: new Date(),
          },
          $inc: { version: 1 },
        },
        { returnDocument: "after" },
      );
      if (!updated)
        return fail("This payroll run changed. Reload and try again.", 409);
      await writeAudit(
        db,
        auth.session,
        "payroll.employee_adjust",
        "payrollRun",
        runInput.id,
        {
          runNo: run.runNo,
          employeeNo: runInput.employeeNo,
          bonus: runInput.bonus,
          overtimePay: runInput.overtimePay,
          additionalDeduction: runInput.additionalDeduction,
          reason: runInput.reason,
        },
      );
      return ok(serialise(updated));
    }

    if (runInput.action === "SET_MALAYSIA_STATUTORY") {
      if (run.status !== "DRAFT")
        return fail("Only a draft payroll run can be reviewed.", 409);
      if (run.currency !== "MYR")
        return fail(
          "Malaysia statutory review requires a MYR payroll run.",
          422,
        );
      const employees = (run.employees as Array<Record<string, unknown>>).map(
        (employee) => {
          if (employee.employeeNo !== runInput.employeeNo) return employee;
          if (employee.countryCode !== "MY")
            throw new Error(
              "Malaysia statutory review only applies to Malaysia employees.",
            );
          const current = employee.amounts as ReturnType<
            typeof calculatePayrollAmounts
          >;
          const previous = employee.statutory as
            Record<string, number> | undefined;
          const previousEmployee = previous
            ? Number(previous.epfEmployee || 0) +
              Number(previous.socsoEmployee || 0) +
              Number(previous.eisEmployee || 0) +
              Number(previous.pcb || 0) +
              Number(previous.zakat || 0) +
              Number(previous.cp38 || 0)
            : 0;
          const previousEmployer = previous
            ? Number(previous.epfEmployer || 0) +
              Number(previous.socsoEmployer || 0) +
              Number(previous.eisEmployer || 0)
            : 0;
          const payTerms = (employee.payTerms || {}) as Record<string, number>;
          const baseEmployeeDeduction = Number(
            payTerms.employeeDeduction ??
              Math.max(0, current.employeeDeduction - previousEmployee),
          );
          const baseEmployerContribution = Number(
            payTerms.employerContribution ??
              Math.max(0, current.employerContribution - previousEmployer),
          );
          const statutory = {
            epfEmployee: runInput.epfEmployee,
            epfEmployer: runInput.epfEmployer,
            socsoEmployee: runInput.socsoEmployee,
            socsoEmployer: runInput.socsoEmployer,
            eisEmployee: runInput.eisEmployee,
            eisEmployer: runInput.eisEmployer,
            pcb: runInput.pcb,
            zakat: runInput.zakat,
            cp38: runInput.cp38,
          };
          const employeeStatutory =
            statutory.epfEmployee +
            statutory.socsoEmployee +
            statutory.eisEmployee +
            statutory.pcb +
            statutory.zakat +
            statutory.cp38;
          const employerStatutory =
            statutory.epfEmployer +
            statutory.socsoEmployer +
            statutory.eisEmployer;
          const currentAccounts = (employee.accounts || {}) as Record<
            string,
            unknown
          >;
          return {
            ...employee,
            accounts: {
              ...currentAccounts,
              epfPayable: currentAccounts.epfPayable || {
                code: "2140",
                name: "EPF payable",
              },
              socsoPayable: currentAccounts.socsoPayable || {
                code: "2150",
                name: "SOCSO payable",
              },
              eisPayable: currentAccounts.eisPayable || {
                code: "2160",
                name: "EIS payable",
              },
              pcbPayable: currentAccounts.pcbPayable || {
                code: "2170",
                name: "PCB payable",
              },
              zakatPayable: currentAccounts.zakatPayable || {
                code: "2180",
                name: "Zakat and CP38 payable",
              },
            },
            payTerms: {
              employeeDeduction: baseEmployeeDeduction,
              employerContribution: baseEmployerContribution,
            },
            amounts: calculatePayrollAmounts(
              {
                basePay: current.basePay,
                fixedAllowance: current.fixedAllowance,
                employeeDeduction: baseEmployeeDeduction + employeeStatutory,
                employerContribution:
                  baseEmployerContribution + employerStatutory,
                bonus: current.bonus,
                overtimePay: current.overtimePay,
                additionalDeduction: current.additionalDeduction,
              },
              business.currency,
            ),
            statutory: {
              ...statutory,
              sourceReference: runInput.sourceReference,
              confirmed: true,
              rulePack: "MY_REVIEWED_2026",
              reviewedAt: new Date(),
              reviewedByName: auth.session.fullName,
            },
          };
        },
      );
      if (
        !employees.some(
          (employee) => employee.employeeNo === runInput.employeeNo,
        )
      )
        return fail("This employee is not in the payroll run.", 404);
      const totals = payrollRunTotals(
        employees as Array<{
          amounts: ReturnType<typeof calculatePayrollAmounts>;
        }>,
        business.currency,
      );
      const updated = await db.collection("payrollRuns").findOneAndUpdate(
        { _id: runId, status: "DRAFT", version: runInput.expectedVersion },
        {
          $set: {
            employees,
            totals,
            lastPreparedBy: new ObjectId(auth.session.id),
            lastPreparedByName: auth.session.fullName,
            updatedAt: new Date(),
          },
          $inc: { version: 1 },
        },
        { returnDocument: "after" },
      );
      if (!updated)
        return fail("This payroll run changed. Reload and try again.", 409);
      await writeAudit(
        db,
        auth.session,
        "payroll.malaysia_statutory_review",
        "payrollRun",
        runInput.id,
        {
          runNo: run.runNo,
          employeeNo: runInput.employeeNo,
          sourceReference: runInput.sourceReference,
        },
      );
      return ok(serialise(updated));
    }

    if (runInput.action === "APPROVE_RUN") {
      if (run.status !== "DRAFT")
        return fail("Only a draft payroll run can be approved.", 409);
      if (
        run.statutoryReviewRequired === true &&
        (run.employees as Array<Record<string, unknown>>).some(
          (employee) =>
            employee.countryCode === "MY" &&
            (employee.statutory as { confirmed?: boolean } | undefined)
              ?.confirmed !== true,
        )
      )
        return fail(
          "Review EPF, SOCSO, EIS, PCB and related Malaysia statutory amounts for every Malaysia employee before approval.",
          409,
        );
      if (
        String(run.lastPreparedBy || run.createdBy) === auth.session.id &&
        auth.session.role !== "OWNER"
      )
        return fail("A different payroll approver must review this run.", 409);
      const updated = await db.collection("payrollRuns").findOneAndUpdate(
        { _id: runId, status: "DRAFT", version: runInput.expectedVersion },
        {
          $set: {
            status: "APPROVED",
            approvedBy: new ObjectId(auth.session.id),
            approvedByName: auth.session.fullName,
            approvedAt: new Date(),
            updatedAt: new Date(),
          },
          $inc: { version: 1 },
        },
        { returnDocument: "after" },
      );
      if (!updated)
        return fail("This payroll run changed. Reload and try again.", 409);
      await writeAudit(
        db,
        auth.session,
        "payroll.run_approve",
        "payrollRun",
        runInput.id,
        { runNo: run.runNo, periodKey: run.periodKey },
      );
      return ok(serialise(updated));
    }

    if (runInput.action === "POST_RUN") {
      const expectedVersion = runInput.expectedVersion;
      const runIdText = runInput.id;
      if (run.status !== "APPROVED")
        return fail("Approve this payroll run before posting it.", 409);
      const amounts = prepareJournalAmounts(
        payrollJournalLines(run as never),
        business.currency,
      );
      const journalId = new ObjectId();
      const session = (await getMongoClient()).startSession();
      try {
        await session.withTransaction(async () => {
          await assertAccountingPeriodOpen(db, String(run.payDate), session);
          const codes = amounts.lines.map((line) => line.accountCode);
          if (
            (await db
              .collection("chartOfAccounts")
              .countDocuments(
                { code: { $in: codes }, active: { $ne: false } },
                { session },
              )) !== new Set(codes).size
          )
            throw new PayrollConflict("A payroll ledger account is inactive.");
          await db.collection("journalEntries").insertOne(
            {
              _id: journalId,
              entryNo: makeDocumentNo("JE"),
              date: new Date(`${run.payDate}T00:00:00Z`),
              businessDate: run.payDate,
              currency: run.currency,
              timeZone: business.timeZone,
              memo: `Payroll accrual ${run.periodKey}`,
              reference: run.runNo,
              source: "PAYROLL_ACCRUAL",
              sourceId: runId,
              status: "POSTED",
              ...amounts,
              createdBy: new ObjectId(auth.session.id),
              createdAt: new Date(),
            },
            { session },
          );
          const updated = await db.collection("payrollRuns").updateOne(
            { _id: runId, status: "APPROVED", version: expectedVersion },
            {
              $set: {
                status: "POSTED",
                journalEntryId: journalId,
                postedBy: new ObjectId(auth.session.id),
                postedAt: new Date(),
                updatedAt: new Date(),
              },
              $inc: { version: 1 },
            },
            { session },
          );
          if (!updated.matchedCount)
            throw new PayrollConflict(
              "This payroll run changed. Reload and try again.",
            );
          await writeAudit(
            db,
            auth.session,
            "payroll.run_post",
            "payrollRun",
            runIdText,
            {
              runNo: run.runNo,
              journalEntryId: journalId.toHexString(),
              totalDebit: amounts.totalDebit,
            },
            session,
          );
        });
      } finally {
        await session.endSession();
      }
      return ok(
        serialise(await db.collection("payrollRuns").findOne({ _id: runId })),
      );
    }

    if (runInput.action !== "PAY_RUN")
      return fail("Choose a payroll payment action.", 422);
    const paymentInput = runInput;
    if (run.status !== "POSTED")
      return fail("Post this payroll run before releasing payment.", 409);
    const paymentAccount = await db.collection("chartOfAccounts").findOne({
      code: paymentInput.paymentAccountCode,
      type: "ASSET",
      active: { $ne: false },
      cashEquivalent: true,
    });
    if (!paymentAccount)
      return fail("Choose an active cash or bank account.", 422);
    const payable = new Map<
      string,
      {
        accountCode: string;
        accountName: string;
        debit: number;
        credit: number;
      }
    >();
    for (const employee of run.employees as Array<{
      amounts: { netPay: number };
      accounts: { payrollPayable: { code: string; name: string } };
    }>) {
      const account = employee.accounts.payrollPayable;
      const line = payable.get(account.code) || {
        accountCode: account.code,
        accountName: account.name,
        debit: 0,
        credit: 0,
      };
      line.debit = roundCurrency(
        line.debit + employee.amounts.netPay,
        business.currency,
      );
      payable.set(account.code, line);
    }
    const paymentAmounts = prepareJournalAmounts(
      [
        ...payable.values(),
        {
          accountCode: String(paymentAccount.code),
          accountName: String(paymentAccount.name),
          debit: 0,
          credit: Number(run.totals.netPay),
        },
      ],
      business.currency,
    );
    const paymentJournalId = new ObjectId();
    const paymentNo = makeDocumentNo("PP");
    const session = (await getMongoClient()).startSession();
    try {
      await session.withTransaction(async () => {
        await assertAccountingPeriodOpen(db, paymentInput.paymentDate, session);
        await db.collection("journalEntries").insertOne(
          {
            _id: paymentJournalId,
            entryNo: makeDocumentNo("JE"),
            date: new Date(`${paymentInput.paymentDate}T00:00:00Z`),
            businessDate: paymentInput.paymentDate,
            currency: run.currency,
            timeZone: business.timeZone,
            memo: `Payroll payment ${run.periodKey}`,
            reference: paymentInput.paymentReference,
            source: "PAYROLL_PAYMENT",
            sourceId: runId,
            status: "POSTED",
            ...paymentAmounts,
            createdBy: new ObjectId(auth.session.id),
            createdAt: new Date(),
          },
          { session },
        );
        const updated = await db.collection("payrollRuns").updateOne(
          {
            _id: runId,
            status: "POSTED",
            version: paymentInput.expectedVersion,
          },
          {
            $set: {
              status: "PAID",
              paymentNo,
              paymentDate: paymentInput.paymentDate,
              paymentReference: paymentInput.paymentReference,
              paymentAccountCode: paymentAccount.code,
              paymentJournalEntryId: paymentJournalId,
              paidBy: new ObjectId(auth.session.id),
              paidAt: new Date(),
              updatedAt: new Date(),
            },
            $inc: { version: 1 },
          },
          { session },
        );
        if (!updated.matchedCount)
          throw new PayrollConflict(
            "This payroll run changed. Reload and try again.",
          );
        await writeAudit(
          db,
          auth.session,
          "payroll.run_pay",
          "payrollRun",
          paymentInput.id,
          {
            runNo: run.runNo,
            paymentNo,
            paymentJournalEntryId: paymentJournalId.toHexString(),
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return ok(
      serialise(await db.collection("payrollRuns").findOne({ _id: runId })),
    );
  } catch (error) {
    if (error instanceof AccountingPeriodClosedError)
      return fail(error.message, error.status);
    if (error instanceof PayrollConflict) return fail(error.message, 409);
    if ((error as { code?: number }).code === 11000)
      return fail(
        "This employee number, team account, payroll month or request already exists.",
        409,
      );
    if (
      error instanceof Error &&
      /payroll|deduction|gross pay|account|precision/i.test(error.message)
    )
      return fail(error.message, 422);
    return publicError(error);
  }
}
