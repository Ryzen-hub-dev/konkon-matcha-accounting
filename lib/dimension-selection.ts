import { ObjectId, type ClientSession, type Db } from "mongodb";
import { z } from "zod";

const optionalDimensionIdSchema = z.union([
  z.string().trim().regex(/^[a-fA-F0-9]{24}$/, "Choose a valid tracking dimension.").transform(value => value.toLowerCase()),
  z.literal(""),
]).default("");

export const dimensionDefaultsInputSchema = z.object({
  costCentreId: optionalDimensionIdSchema,
  projectId: optionalDimensionIdSchema,
});
export const dimensionDefaultsSchema = dimensionDefaultsInputSchema.default({ costCentreId: "", projectId: "" });

export const documentDimensionSelectionSchema = z.object({
  mode: z.enum(["CUSTOMER_DEFAULT", "CUSTOM", "NONE"]).default("CUSTOMER_DEFAULT"),
  costCentreId: optionalDimensionIdSchema,
  projectId: optionalDimensionIdSchema,
}).default({ mode: "CUSTOMER_DEFAULT", costCentreId: "", projectId: "" }).superRefine((value, context) => {
  if (value.mode === "CUSTOM" && !value.costCentreId && !value.projectId) {
    context.addIssue({ code: "custom", path: ["costCentreId"], message: "Choose a cost centre, a project, or use another classification mode." });
  }
});

export class DimensionSelectionError extends Error {}

export type DimensionReferenceSnapshot = { id: ObjectId; code: string; name: string };
export type ResolvedDimensionPair = { costCentre?: DimensionReferenceSnapshot; project?: DimensionReferenceSnapshot };
export type DocumentDimensionSelection = ResolvedDimensionPair & {
  mode: "CUSTOMER_DEFAULT" | "CUSTOM" | "NONE";
  source: "CUSTOMER_ACCOUNT" | "DOCUMENT_OVERRIDE" | "EXPLICIT_NONE" | "PRODUCT_MASTER";
  memberId?: ObjectId;
  productId?: ObjectId;
  resolvedAt: Date;
};
export type DimensionedJournalLine<T> = T & {
  costCentre?: DimensionReferenceSnapshot;
  project?: DimensionReferenceSnapshot;
  dimensionSource?: { type: DocumentDimensionSelection["source"]; mode: DocumentDimensionSelection["mode"] };
};

type DimensionPairInput = { costCentreId?: string | ObjectId; projectId?: string | ObjectId };

export async function resolveDimensionPair(db: Db, input: DimensionPairInput, session?: ClientSession): Promise<ResolvedDimensionPair> {
  const costCentreId = input.costCentreId ? String(input.costCentreId) : "";
  const projectId = input.projectId ? String(input.projectId) : "";
  const ids = [...new Set([costCentreId, projectId].filter(Boolean))];
  if (!ids.length) return {};
  if (ids.some(id => !ObjectId.isValid(id))) throw new DimensionSelectionError("Choose valid management dimensions.");
  const dimensions = await db.collection("accountingDimensions").find(
    { _id: { $in: ids.map(id => new ObjectId(id)) }, active: { $ne: false } },
    session ? { session } : undefined,
  ).project({ type: 1, code: 1, name: 1 }).toArray();
  const costCentre = costCentreId ? dimensions.find(dimension => String(dimension._id) === costCentreId && dimension.type === "COST_CENTRE") : null;
  const project = projectId ? dimensions.find(dimension => String(dimension._id) === projectId && dimension.type === "PROJECT") : null;
  if ((costCentreId && !costCentre) || (projectId && !project)) {
    throw new DimensionSelectionError("A selected cost centre or project is inactive or has the wrong type.");
  }
  return {
    ...(costCentre ? { costCentre: { id: costCentre._id, code: String(costCentre.code), name: String(costCentre.name) } } : {}),
    ...(project ? { project: { id: project._id, code: String(project.code), name: String(project.name) } } : {}),
  };
}

export async function resolveProductDimensionSelections(
  db: Db,
  products: Array<{ _id: ObjectId; name?: unknown; dimensionDefaults?: { costCentre?: { id?: unknown }; project?: { id?: unknown } } }>,
  session?: ClientSession,
  resolvedAt = new Date(),
) {
  const requestedIds = [...new Set(products.flatMap(product => [
    product.dimensionDefaults?.costCentre?.id,
    product.dimensionDefaults?.project?.id,
  ]).filter(Boolean).map(String))];
  if (requestedIds.some(id => !ObjectId.isValid(id))) {
    throw new DimensionSelectionError("A product has an invalid default cost centre or project. Update the product before checkout.");
  }
  const dimensions = requestedIds.length ? await db.collection("accountingDimensions").find(
    { _id: { $in: requestedIds.map(id => new ObjectId(id)) }, active: { $ne: false } },
    session ? { session } : undefined,
  ).project({ type: 1, code: 1, name: 1 }).toArray() : [];
  const selections = new Map<string, DocumentDimensionSelection>();
  for (const product of products) {
    const costCentreId = product.dimensionDefaults?.costCentre?.id ? String(product.dimensionDefaults.costCentre.id) : "";
    const projectId = product.dimensionDefaults?.project?.id ? String(product.dimensionDefaults.project.id) : "";
    if (!costCentreId && !projectId) continue;
    const costCentre = costCentreId ? dimensions.find(dimension => String(dimension._id) === costCentreId && dimension.type === "COST_CENTRE") : null;
    const project = projectId ? dimensions.find(dimension => String(dimension._id) === projectId && dimension.type === "PROJECT") : null;
    if ((costCentreId && !costCentre) || (projectId && !project)) {
      throw new DimensionSelectionError(`${String(product.name || "A product")} uses an inactive or invalid default accounting dimension. Update the product before checkout.`);
    }
    selections.set(product._id.toHexString(), {
      mode: "CUSTOM",
      source: "PRODUCT_MASTER",
      productId: product._id,
      resolvedAt,
      ...(costCentre ? { costCentre: { id: costCentre._id, code: String(costCentre.code), name: String(costCentre.name) } } : {}),
      ...(project ? { project: { id: project._id, code: String(project.code), name: String(project.name) } } : {}),
    });
  }
  return selections;
}

export async function resolveDocumentDimensionSelection(
  db: Db,
  input: z.infer<typeof documentDimensionSelectionSchema>,
  member: Record<string, any> | null | undefined,
  session?: ClientSession,
  resolvedAt = new Date(),
): Promise<DocumentDimensionSelection> {
  if (input.mode === "NONE") return { mode: "NONE", source: "EXPLICIT_NONE", resolvedAt };
  if (input.mode === "CUSTOM") {
    const pair = await resolveDimensionPair(db, input, session);
    if (!pair.costCentre && !pair.project) throw new DimensionSelectionError("Choose a cost centre, a project, or use another classification mode.");
    return { ...pair, mode: "CUSTOM", source: "DOCUMENT_OVERRIDE", resolvedAt };
  }
  const defaults = member?.dimensionDefaults || {};
  const pair = await resolveDimensionPair(db, {
    costCentreId: defaults.costCentre?.id,
    projectId: defaults.project?.id,
  }, session);
  return {
    ...pair,
    mode: "CUSTOMER_DEFAULT",
    source: "CUSTOMER_ACCOUNT",
    ...(member?._id instanceof ObjectId ? { memberId: member._id } : {}),
    resolvedAt,
  };
}

export function applyDocumentDimensions<T extends Record<string, unknown>>(lines: T[], selection: DocumentDimensionSelection | null | undefined): DimensionedJournalLine<T>[] {
  if (!selection?.costCentre && !selection?.project) return lines;
  return lines.map(line => ({
    ...line,
    ...(selection.costCentre ? { costCentre: selection.costCentre } : {}),
    ...(selection.project ? { project: selection.project } : {}),
    dimensionSource: { type: selection.source, mode: selection.mode },
  }));
}
