import { z } from "zod";
import { currencyCodeSchema, currencyMinorUnits, roundCurrency } from "@/lib/international";
import { isValidDateKey } from "@/lib/dates";

const accountTypeSchema = z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]);
const amount = z.number().finite().nonnegative().max(1_000_000_000_000);
const rowSchema = z.object({
  accountCode: z.string().trim().min(1).max(30),
  accountName: z.string().trim().min(1).max(120),
  accountType: accountTypeSchema,
  debit: amount,
  credit: amount,
}).strict().refine(value => !(value.debit && value.credit), "An account row cannot be both debit and credit.");

const entitySchema = z.object({
  entityCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,30}$/),
  entityName: z.string().trim().min(2).max(120),
  countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  functionalCurrency: currencyCodeSchema,
  closingRate: z.number().finite().positive().max(1_000_000),
  averageRate: z.number().finite().positive().max(1_000_000),
  rows: z.array(rowSchema).min(1).max(1_000),
}).strict();

const eliminationSchema = z.object({
  reference: z.string().trim().min(2).max(80),
  reason: z.string().trim().min(3).max(300),
  lines: z.array(rowSchema).min(2).max(100),
}).strict();

export const consolidationInputSchema = z.object({
  clientRequestId: z.string().uuid(),
  periodFrom: z.string().refine(isValidDateKey, "Choose a valid start date."),
  periodTo: z.string().refine(isValidDateKey, "Choose a valid end date."),
  reportingCurrency: currencyCodeSchema,
  currentEntityCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,30}$/),
  currentEntityClosingRate: z.coerce.number().finite().positive().max(1_000_000),
  currentEntityAverageRate: z.coerce.number().finite().positive().max(1_000_000),
  importedEntities: z.array(entitySchema).max(20).default([]),
  eliminations: z.array(eliminationSchema).max(100).default([]),
  reviewNote: z.string().trim().min(3).max(500),
}).strict().superRefine((value, context) => {
  if (value.periodFrom > value.periodTo) context.addIssue({ code: "custom", path: ["periodTo"], message: "End date must not precede start date." });
  const codes = [value.currentEntityCode, ...value.importedEntities.map(entity => entity.entityCode)];
  if (new Set(codes).size !== codes.length) context.addIssue({ code: "custom", path: ["importedEntities"], message: "Entity codes must be unique." });
});

export type ConsolidationEntity = z.infer<typeof entitySchema>;
export type ConsolidationElimination = z.infer<typeof eliminationSchema>;

export class ConsolidationError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

function assertBalanced(rows: ConsolidationEntity["rows"], currency: string, label: string) {
  const debit = rows.reduce((sum, row) => sum + currencyMinorUnits(row.debit, currency), 0);
  const credit = rows.reduce((sum, row) => sum + currencyMinorUnits(row.credit, currency), 0);
  if (debit !== credit) throw new ConsolidationError(`${label} trial balance is not balanced in ${currency}.`);
}

export function consolidateGroup(
  entities: ConsolidationEntity[],
  eliminations: ConsolidationElimination[],
  reportingCurrency: string,
) {
  if (!entities.length) throw new ConsolidationError("Add at least one entity to consolidate.");
  const grouped = new Map<string, { accountCode: string; accountName: string; accountType: z.infer<typeof accountTypeSchema>; debit: number; credit: number; entities: Set<string> }>();
  const entitySummaries: Array<{ entityCode: string; entityName: string; functionalCurrency: string; translatedDebit: number; translatedCredit: number; translationReserve: number }> = [];
  const add = (row: z.infer<typeof rowSchema>, entityCode: string) => {
    const key = `${row.accountType}:${row.accountCode}`;
    const current = grouped.get(key) || { accountCode: row.accountCode, accountName: row.accountName, accountType: row.accountType, debit: 0, credit: 0, entities: new Set<string>() };
    current.debit = roundCurrency(current.debit + row.debit, reportingCurrency);
    current.credit = roundCurrency(current.credit + row.credit, reportingCurrency);
    current.entities.add(entityCode);
    grouped.set(key, current);
  };

  for (const entity of entities) {
    assertBalanced(entity.rows, entity.functionalCurrency, entity.entityName);
    const translated = entity.rows.map(row => {
      const rate = ["REVENUE", "EXPENSE"].includes(row.accountType) ? entity.averageRate : entity.closingRate;
      return { ...row, debit: roundCurrency(row.debit * rate, reportingCurrency), credit: roundCurrency(row.credit * rate, reportingCurrency) };
    });
    let debit = roundCurrency(translated.reduce((sum, row) => sum + row.debit, 0), reportingCurrency);
    let credit = roundCurrency(translated.reduce((sum, row) => sum + row.credit, 0), reportingCurrency);
    const reserve = roundCurrency(debit - credit, reportingCurrency);
    if (reserve > 0) translated.push({ accountCode: "3999", accountName: "Foreign currency translation reserve", accountType: "EQUITY", debit: 0, credit: reserve });
    if (reserve < 0) translated.push({ accountCode: "3999", accountName: "Foreign currency translation reserve", accountType: "EQUITY", debit: -reserve, credit: 0 });
    debit = roundCurrency(translated.reduce((sum, row) => sum + row.debit, 0), reportingCurrency);
    credit = roundCurrency(translated.reduce((sum, row) => sum + row.credit, 0), reportingCurrency);
    for (const row of translated) add(row, entity.entityCode);
    entitySummaries.push({ entityCode: entity.entityCode, entityName: entity.entityName, functionalCurrency: entity.functionalCurrency, translatedDebit: debit, translatedCredit: credit, translationReserve: reserve });
  }

  for (const elimination of eliminations) {
    assertBalanced(elimination.lines, reportingCurrency, `Elimination ${elimination.reference}`);
    for (const row of elimination.lines) add(row, `ELIM:${elimination.reference}`);
  }

  const rows = [...grouped.values()].map(row => ({ ...row, entities: [...row.entities].sort() }))
    .filter(row => currencyMinorUnits(row.debit, reportingCurrency) || currencyMinorUnits(row.credit, reportingCurrency))
    .sort((left, right) => left.accountCode.localeCompare(right.accountCode) || left.accountType.localeCompare(right.accountType));
  const totalDebit = roundCurrency(rows.reduce((sum, row) => sum + row.debit, 0), reportingCurrency);
  const totalCredit = roundCurrency(rows.reduce((sum, row) => sum + row.credit, 0), reportingCurrency);
  if (currencyMinorUnits(totalDebit, reportingCurrency) !== currencyMinorUnits(totalCredit, reportingCurrency)) throw new ConsolidationError("Translated consolidation is not balanced.");
  return { rows, entities: entitySummaries, totalDebit, totalCredit, reportingCurrency, eliminationCount: eliminations.length };
}
