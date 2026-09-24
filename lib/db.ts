import { CollectionOptions, Db, MongoClient, ServerApiVersion } from "mongodb";
import { EXPIRING_AUDIT_ACTIONS, OPERATIONAL_LOG_DAYS } from "./data-retention";

type MongoCache = {
  clientPromise?: Promise<MongoClient>;
  indexPromise?: Promise<void>;
};

type ExistingIndex = {
  name?: string;
  sparse?: boolean;
  key?: Record<string, number>;
  expireAfterSeconds?: number;
  partialFilterExpression?: {
    action?: { $in?: unknown[] };
  };
};

type IndexMigrationRecord = {
  _id: string;
  completedAt?: Date;
};

// Bump this value whenever the index definitions below change. The durable marker
// prevents every new Vercel function instance from re-checking the full index set.
export const INDEX_SCHEMA_VERSION = "indexes-2026-09-24-v13";

const mongoCache = globalThis as typeof globalThis & {
  __konkonMongo?: MongoCache;
};

function getConfig() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME || "konkon_matcha_accounting";
  const collectionPrefix =
    process.env.MONGODB_COLLECTION_PREFIX?.trim() || "konkon_";

  if (!uri) {
    throw new Error("MONGODB_URI is not configured.");
  }
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(collectionPrefix)) {
    throw new Error("MONGODB_COLLECTION_PREFIX is invalid.");
  }

  return { uri, dbName, collectionPrefix };
}

export function scopedCollectionName(
  name: string,
  prefix = process.env.MONGODB_COLLECTION_PREFIX?.trim() || "konkon_",
) {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(prefix))
    throw new Error("MONGODB_COLLECTION_PREFIX is invalid.");
  return `${prefix}${name}`;
}

function scopeCollections(db: Db, prefix: string) {
  return new Proxy(db, {
    get(target, property) {
      if (property === "collection") {
        return (name: string, options?: CollectionOptions) =>
          target.collection(scopedCollectionName(name, prefix), options);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

async function ensureMemberCardIndexes(db: Db) {
  const collection = db.collection("memberCards");
  let indexes: Array<{ name?: string; partialFilterExpression?: unknown }> = [];
  try {
    indexes = (await collection.listIndexes().toArray()) as Array<{
      name?: string;
      partialFilterExpression?: unknown;
    }>;
  } catch (error) {
    if ((error as { code?: number }).code !== 26) throw error;
  }
  const legacyTokenIndex = indexes.find(
    (index) => index.name === "tokenHash_1" && !index.partialFilterExpression,
  );
  if (legacyTokenIndex?.name) await collection.dropIndex(legacyTokenIndex.name);
  await Promise.all([
    collection.createIndex(
      { tokenHash: 1 },
      {
        unique: true,
        partialFilterExpression: { tokenHash: { $type: "string" } },
      },
    ),
    collection.createIndex(
      { bindingHash: 1 },
      {
        unique: true,
        partialFilterExpression: { bindingHash: { $type: "string" } },
      },
    ),
  ]);
}

export function stableOptionalStringIndexOptions(field: string) {
  return {
    name: `${field}_stable_unique_v1`,
    unique: true,
    partialFilterExpression: { [field]: { $type: "string" } },
  };
}

export function stableDistinctPipeline(
  field: string,
  filter?: Record<string, unknown>,
) {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(field))
    throw new Error("The distinct field path is invalid.");
  return [
    ...(filter && Object.keys(filter).length ? [{ $match: filter }] : []),
    { $group: { _id: `$${field}` } },
  ];
}

export function indexMigrationIsComplete(
  record: Pick<IndexMigrationRecord, "completedAt"> | null | undefined,
) {
  return (
    record?.completedAt instanceof Date &&
    !Number.isNaN(record.completedAt.getTime())
  );
}

async function ensureStableOptionalStringUniqueIndex(
  db: Db,
  collectionName: string,
  field: string,
) {
  const collection = db.collection(collectionName);
  await collection.createIndex(
    { [field]: 1 },
    stableOptionalStringIndexOptions(field),
  );

  const indexes = (await collection.listIndexes().toArray()) as ExistingIndex[];
  const legacySparseIndex = indexes.find(
    (index) => index.name === `${field}_1` && index.sparse,
  );
  if (!legacySparseIndex?.name) return;

  try {
    await collection.dropIndex(legacySparseIndex.name);
  } catch (error) {
    if ((error as { code?: number }).code !== 27) throw error;
  }
}

export function auditExpiryIndexMatches(index: ExistingIndex) {
  const actions = index.partialFilterExpression?.action?.$in;
  if (
    Number(index.key?.expiresAt) !== 1 ||
    Number(index.expireAfterSeconds) !== 0 ||
    !Array.isArray(actions)
  ) return false;
  const expected = [...EXPIRING_AUDIT_ACTIONS].sort();
  const actual = actions.filter((value): value is string => typeof value === "string").sort();
  return actual.length === expected.length && actual.every((value, position) => value === expected[position]);
}

async function ensureAuditExpiryIndex(db: Db) {
  const collection = db.collection("auditLogs");
  let indexes: ExistingIndex[] = [];
  try {
    indexes = await collection.listIndexes().toArray() as ExistingIndex[];
  } catch (error) {
    if ((error as { code?: number }).code !== 26) throw error;
  }
  if (indexes.some(auditExpiryIndexMatches)) return;

  const replacementName = "audit_expiry_v13";
  await collection.createIndex(
    { expiresAt: 1 },
    {
      name: replacementName,
      expireAfterSeconds: 0,
      partialFilterExpression: { action: { $in: EXPIRING_AUDIT_ACTIONS } },
    },
  );
  for (const index of indexes) {
    if (index.name && Number(index.key?.expiresAt) === 1) {
      try { await collection.dropIndex(index.name); }
      catch (error) { if ((error as { code?: number }).code !== 27) throw error; }
    }
  }
}

export function getMongoClient(): Promise<MongoClient> {
  const { uri } = getConfig();
  mongoCache.__konkonMongo ??= {};

  if (!mongoCache.__konkonMongo.clientPromise) {
    const client = new MongoClient(uri, {
      appName: "konkon-matcha-accounting",
      maxPoolSize: 5,
      minPoolSize: 0,
      maxIdleTimeMS: 60_000,
      serverSelectionTimeoutMS: 7_500,
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });
    mongoCache.__konkonMongo.clientPromise = client
      .connect()
      .catch(async (error) => {
        mongoCache.__konkonMongo!.clientPromise = undefined;
        await client.close().catch(() => undefined);
        throw error;
      });
  }

  return mongoCache.__konkonMongo.clientPromise;
}

async function initializeIndexes(db: Db) {
  const migrations = db.collection<IndexMigrationRecord>("schemaMigrations");
  const current = await migrations.findOne(
    { _id: INDEX_SCHEMA_VERSION },
    { projection: { completedAt: 1 } },
  );
  if (indexMigrationIsComplete(current)) return;

  await Promise.all([
    ensureMemberCardIndexes(db),
    db
      .collection("memberCards")
      .createIndex({ clientRequestId: 1 }, { unique: true }),
    db.collection("memberCards").createIndex({ memberId: 1, status: 1 }),
    db.collection("memberCards").createIndex(
      { deletedAt: 1 },
      {
        expireAfterSeconds: OPERATIONAL_LOG_DAYS * 86_400,
        partialFilterExpression: { status: "DELETED" },
      },
    ),
    db
      .collection("users")
      .createIndex({ usernameNormalized: 1 }, { unique: true }),
    db
      .collection("users")
      .createIndex(
        { selectionTokenHash: 1 },
        stableOptionalStringIndexOptions("selectionTokenHash"),
      ),
    db.collection("users").createIndex(
      { emailNormalized: 1 },
      {
        unique: true,
        partialFilterExpression: { emailNormalized: { $type: "string" } },
      },
    ),
    db.collection("products").createIndex({ sku: 1 }, { unique: true }),
    db.collection("products").createIndex(
      { barcode: 1 },
      {
        unique: true,
        partialFilterExpression: { barcode: { $type: "string" } },
      },
    ),
    db.collection("products").createIndex({ category: 1, name: 1 }),
    db
      .collection("inventoryBalances")
      .createIndex({ productId: 1, locationId: 1 }, { unique: true }),
    db
      .collection("inventoryBalances")
      .createIndex({ locationId: 1, quantity: 1, productName: 1 }),
    db
      .collection("inventoryActivations")
      .createIndex({ clientRequestId: 1 }, { unique: true }),
    db
      .collection("inventoryActivations")
      .createIndex({ productId: 1 }, { unique: true }),
    db
      .collection("inventoryBatches")
      .createIndex(
        { productId: 1, locationId: 1, lotKey: 1, expiryDate: 1 },
        { unique: true },
      ),
    db
      .collection("inventoryBatches")
      .createIndex({ locationId: 1, expiryDate: 1, quantity: 1 }),
    db
      .collection("inventoryBatches")
      .createIndex({ productId: 1, expiryDate: 1, quantity: 1 }),
    db.collection("inventoryBatches").createIndex({ lotKey: 1, createdAt: 1 }),
    db
      .collection("inventoryBatchActivations")
      .createIndex({ clientRequestId: 1 }, { unique: true }),
    db
      .collection("inventoryBatchActivations")
      .createIndex({ productId: 1 }, { unique: true }),
    db
      .collection("inventoryBatchEvents")
      .createIndex({ clientRequestId: 1 }, { unique: true }),
    db
      .collection("inventoryBatchEvents")
      .createIndex({ batchId: 1, createdAt: -1 }),
    db
      .collection("inventoryBatchEvents")
      .createIndex({ productId: 1, lotKey: 1, createdAt: -1 }),
    db
      .collection("stockTransfers")
      .createIndex({ transferNo: 1 }, { unique: true }),
    db
      .collection("stockTransfers")
      .createIndex({ clientRequestId: 1 }, { unique: true }),
    db
      .collection("stockTransfers")
      .createIndex({ status: 1, dispatchedAt: -1 }),
    db.collection("stockTransfers").createIndex({
      sourceLocationId: 1,
      destinationLocationId: 1,
      status: 1,
    }),
    db
      .collection("stockTransfers")
      .createIndex({ "items.batchAllocations.lotKey": 1, dispatchedAt: -1 }),
    db.collection("members").createIndex({ memberNo: 1 }, { unique: true }),
    db.collection("members").createIndex(
      { memberCardCode: 1 },
      {
        unique: true,
        partialFilterExpression: { memberCardCode: { $type: "string" } },
      },
    ),
    db.collection("members").createIndex(
      { identityLookupHash: 1 },
      {
        unique: true,
        partialFilterExpression: { identityLookupHash: { $type: "string" } },
      },
    ),
    db.collection("members").createIndex(
      { phone: 1 },
      {
        unique: true,
        partialFilterExpression: { phone: { $type: "string" } },
      },
    ),
    db.collection("sales").createIndex({ receiptNo: 1 }, { unique: true }),
    db.collection("sales").createIndex(
      { clientRequestId: 1 },
      {
        unique: true,
        partialFilterExpression: { clientRequestId: { $type: "string" } },
      },
    ),
    db.collection("sales").createIndex({ createdAt: -1 }),
    db.collection("sales").createIndex({ shiftId: 1, createdAt: 1 }),
    db
      .collection("sales")
      .createIndex({ "items.batchAllocations.lotKey": 1, createdAt: -1 }),
    db.collection("sales").createIndex(
      { paymentProvider: 1, paymentReferenceNormalized: 1 },
      {
        unique: true,
        partialFilterExpression: {
          paymentVerificationMode: "STATIC_QR",
          paymentReferenceNormalized: { $type: "string" },
        },
      },
    ),
    db.collection("settingsHistory").createIndex({ key: 1, createdAt: -1 }),
    db.collection("locations").createIndex({ code: 1 }, { unique: true }),
    ensureStableOptionalStringUniqueIndex(db, "locations", "systemKey"),
    db.collection("locations").createIndex({ parentLocationId: 1, active: 1 }),
    db
      .collection("locations")
      .createIndex({ countryCode: 1, type: 1, active: 1 }),
    db.collection("counters").createIndex({ code: 1 }, { unique: true }),
    ensureStableOptionalStringUniqueIndex(db, "counters", "systemKey"),
    db.collection("counters").createIndex({ locationId: 1, active: 1 }),
    db.collection("counters").createIndex({ managerIds: 1, active: 1 }),
    db
      .collection("registerShifts")
      .createIndex({ shiftNo: 1 }, { unique: true }),
    db
      .collection("registerShifts")
      .createIndex({ openRequestId: 1 }, { unique: true }),
    db.collection("registerShifts").createIndex(
      { closeRequestId: 1 },
      {
        unique: true,
        partialFilterExpression: { closeRequestId: { $type: "string" } },
      },
    ),
    db
      .collection("registerShifts")
      .createIndex(
        { counterId: 1, status: 1 },
        { unique: true, partialFilterExpression: { status: "OPEN" } },
      ),
    db.collection("registerShifts").createIndex({ counterId: 1, openedAt: -1 }),
    db.collection("registerShifts").createIndex({ status: 1, closedAt: -1 }),
    db
      .collection("receiptTemplates")
      .createIndex({ nameNormalized: 1 }, { unique: true }),
    ensureStableOptionalStringUniqueIndex(db, "receiptTemplates", "systemKey"),
    db
      .collection("receiptTemplates")
      .createIndex({ isDefault: -1, updatedAt: -1 }),
    db.collection("refunds").createIndex({ refundNo: 1 }, { unique: true }),
    db.collection("refunds").createIndex(
      { clientRequestId: 1 },
      {
        unique: true,
        partialFilterExpression: { clientRequestId: { $type: "string" } },
      },
    ),
    db.collection("refunds").createIndex({ saleId: 1, createdAt: -1 }),
    db.collection("refunds").createIndex({ shiftId: 1, createdAt: 1 }),
    db
      .collection("refunds")
      .createIndex({ "items.batchAllocations.lotKey": 1, createdAt: -1 }),
    db
      .collection("journalEntries")
      .createIndex({ entryNo: 1 }, { unique: true }),
    db.collection("journalEntries").createIndex({ status: 1, date: 1 }),
    db
      .collection("journalEntries")
      .createIndex({ "lines.accountCode": 1, status: 1, date: 1 }),
    db
      .collection("accountingPeriods")
      .createIndex({ periodKey: 1 }, { unique: true }),
    db
      .collection("accountingPeriods")
      .createIndex({ status: 1, periodKey: -1 }),
    db.collection("fixedAssets").createIndex({ assetNo: 1 }, { unique: true }),
    db
      .collection("fixedAssets")
      .createIndex({ clientRequestId: 1 }, { unique: true }),
    db
      .collection("fixedAssets")
      .createIndex({ status: 1, category: 1, assetNo: 1 }),
    db
      .collection("fixedAssetDepreciation")
      .createIndex({ assetId: 1, periodKey: 1 }, { unique: true }),
    db
      .collection("fixedAssetDepreciation")
      .createIndex({ periodKey: 1, postedAt: -1 }),
    db
      .collection("fixedAssetDepreciationRuns")
      .createIndex({ runNo: 1 }, { unique: true }),
    db
      .collection("fixedAssetDepreciationRuns")
      .createIndex({ clientRequestId: 1 }, { unique: true }),
    db
      .collection("fixedAssetDepreciationRuns")
      .createIndex({ periodKey: -1, createdAt: -1 }),
    db
      .collection("fixedAssetDisposals")
      .createIndex({ disposalNo: 1 }, { unique: true }),
    db
      .collection("fixedAssetDisposals")
      .createIndex({ clientRequestId: 1 }, { unique: true }),
    db
      .collection("fixedAssetDisposals")
      .createIndex({ assetId: 1 }, { unique: true }),
    db
      .collection("expenseClaims")
      .createIndex({ claimNo: 1 }, { unique: true }),
    db
      .collection("expenseClaims")
      .createIndex({ clientRequestId: 1 }, { unique: true }),
    db
      .collection("expenseClaims")
      .createIndex({ claimantId: 1, createdAt: -1 }),
    db.collection("expenseClaims").createIndex({ status: 1, updatedAt: -1 }),
    db
      .collection("expenseAttachments")
      .createIndex({ claimId: 1, createdAt: 1 }),
    db
      .collection("expensePayments")
      .createIndex({ paymentNo: 1 }, { unique: true }),
    db
      .collection("expensePayments")
      .createIndex({ clientRequestId: 1 }, { unique: true }),
    db
      .collection("expensePayments")
      .createIndex({ claimId: 1 }, { unique: true }),
    db
      .collection("payrollProfiles")
      .createIndex({ userId: 1 }, { unique: true }),
    db
      .collection("payrollProfiles")
      .createIndex({ employeeNo: 1 }, { unique: true }),
    db
      .collection("payrollProfiles")
      .createIndex({ active: 1, countryCode: 1, employeeNo: 1 }),
    db
      .collection("payrollRuns")
      .createIndex({ periodKey: 1 }, { unique: true }),
    db
      .collection("payrollRuns")
      .createIndex({ clientRequestId: 1 }, { unique: true }),
    db.collection("payrollRuns").createIndex({ status: 1, payDate: -1 }),
    db
      .collection("consolidationRuns")
      .createIndex({ runNo: 1 }, { unique: true }),
    db
      .collection("consolidationRuns")
      .createIndex({ clientRequestId: 1 }, { unique: true }),
    db
      .collection("consolidationRuns")
      .createIndex({ periodTo: -1, createdAt: -1 }),
    db
      .collection("bankReconciliations")
      .createIndex({ reconciliationNo: 1 }, { unique: true }),
    ensureStableOptionalStringUniqueIndex(
      db,
      "bankReconciliations",
      "clientRequestId",
    ),
    db
      .collection("bankReconciliations")
      .createIndex({ accountCode: 1, statementDate: -1, status: 1 }),
    db
      .collection("bankReconciliations")
      .createIndex(
        { accountCode: 1, status: 1 },
        { unique: true, partialFilterExpression: { status: "DRAFT" } },
      ),
    db
      .collection("bankReconciliationMatches")
      .createIndex({ reconciliationId: 1, rowId: 1 }, { unique: true }),
    db
      .collection("bankReconciliationMatches")
      .createIndex({ journalEntryId: 1, lineIndex: 1 }, { unique: true }),
    db.collection("invoices").createIndex({ invoiceNo: 1 }, { unique: true }),
    db.collection("invoices").createIndex(
      { clientRequestId: 1 },
      {
        unique: true,
        partialFilterExpression: { clientRequestId: { $type: "string" } },
      },
    ),
    db.collection("invoices").createIndex({ dueDate: 1, status: 1 }),
    db
      .collection("invoices")
      .createIndex({ memberId: 1, status: 1, dueDate: 1 }),
    db.collection("invoices").createIndex(
      { sourceQuoteId: 1 },
      {
        unique: true,
        partialFilterExpression: { sourceQuoteId: { $type: "objectId" } },
      },
    ),
    db
      .collection("quotations")
      .createIndex({ quotationNo: 1 }, { unique: true }),
    ensureStableOptionalStringUniqueIndex(db, "quotations", "clientRequestId"),
    db
      .collection("quotations")
      .createIndex({ status: 1, validUntil: 1, createdAt: -1 }),
    db.collection("quotations").createIndex({ memberId: 1, createdAt: -1 }),
    db
      .collection("deliveryOrders")
      .createIndex({ deliveryOrderNo: 1 }, { unique: true }),
    db.collection("deliveryOrders").createIndex(
      { sourceQuoteId: 1 },
      {
        unique: true,
        partialFilterExpression: { sourceQuoteId: { $type: "objectId" } },
      },
    ),
    ensureStableOptionalStringUniqueIndex(
      db,
      "deliveryOrders",
      "clientRequestId",
    ),
    db
      .collection("deliveryOrders")
      .createIndex({ status: 1, scheduledDate: 1, createdAt: -1 }),
    db.collection("deliveryOrders").createIndex({ memberId: 1, createdAt: -1 }),
    db
      .collection("deliveryOrders")
      .createIndex({ carrierCode: 1, trackingReference: 1 }),
    db
      .collection("shippingWaybills")
      .createIndex({ deliveryOrderId: 1 }, { unique: true }),
    db
      .collection("shippingWaybills")
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db
      .collection("shippingWebhookEvents")
      .createIndex({ provider: 1, fingerprint: 1 }, { unique: true }),
    db
      .collection("shippingWebhookEvents")
      .createIndex({ trackingReference: 1, providerTimestamp: -1 }),
    db
      .collection("shippingWebhookEvents")
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db
      .collection("invoiceTemplates")
      .createIndex({ nameNormalized: 1 }, { unique: true }),
    ensureStableOptionalStringUniqueIndex(db, "invoiceTemplates", "systemKey"),
    db
      .collection("invoiceTemplates")
      .createIndex({ isDefault: -1, updatedAt: -1 }),
    db.collection("auditLogs").createIndex({ createdAt: -1 }),
    db.collection("auditLogs").createIndex({ actorId: 1, createdAt: -1 }),
    ensureAuditExpiryIndex(db),
    db
      .collection("operationalReviews")
      .createIndex({ reviewNo: 1 }, { unique: true }),
    db
      .collection("operationalReviews")
      .createIndex(
        { sourceType: 1, sourceId: 1, ruleCode: 1 },
        { unique: true },
      ),
    db
      .collection("operationalReviews")
      .createIndex({ status: 1, severityRank: -1, occurredAt: -1 }),
    db
      .collection("operationalReviews")
      .createIndex({ category: 1, status: 1, occurredAt: -1 }),
    db.collection("coupons").createIndex({ code: 1 }, { unique: true }),
    db.collection("coupons").createIndex({ active: 1, expiresAt: 1 }),
    db
      .collection("couponRedemptions")
      .createIndex({ couponId: 1, memberId: 1, createdAt: -1 }),
    db
      .collection("couponRedemptions")
      .createIndex({ saleId: 1 }, { unique: true }),
    db.collection("paymentMethods").createIndex({ code: 1 }, { unique: true }),
    ensureStableOptionalStringUniqueIndex(db, "paymentMethods", "systemKey"),
    db.collection("paymentMethods").createIndex({ active: 1, sortOrder: 1 }),
    db
      .collection("exchangeRates")
      .createIndex({ baseCurrency: 1, quoteCurrency: 1 }, { unique: true }),
    db.collection("exchangeRates").createIndex({ active: 1, updatedAt: -1 }),
    db
      .collection("paymentIntents")
      .createIndex({ intentNo: 1 }, { unique: true }),
    db
      .collection("paymentIntents")
      .createIndex({ createdBy: 1, status: 1, expiresAt: 1 }),
    db
      .collection("paymentIntents")
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 86_400 }),
    db
      .collection("paymentConfirmations")
      .createIndex({ provider: 1, externalReference: 1 }, { unique: true }),
    db
      .collection("paymentConfirmations")
      .createIndex({ verificationCodeHash: 1 }, { unique: true }),
    db
      .collection("paymentWebhookEvents")
      .createIndex({ eventId: 1 }, { unique: true }),
    db
      .collection("paymentWebhookEvents")
      .createIndex({ createdAt: 1 }, { expireAfterSeconds: 2_592_000 }),
    db
      .collection("localPaymentEvents")
      .createIndex({ eventId: 1 }, { unique: true }),
    db
      .collection("localPaymentEvents")
      .createIndex({ provider: 1, currency: 1, paidAt: -1 }),
    db
      .collection("localPaymentEvents")
      .createIndex({ status: 1, createdAt: -1 }),
    db
      .collection("localPaymentEvents")
      .createIndex({ candidateIntentId: 1, status: 1 }),
    db
      .collection("localPaymentEvents")
      .createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
    db
      .collection("scannerSessions")
      .createIndex({ tokenHash: 1 }, { unique: true }),
    db
      .collection("eInvoices")
      .createIndex({ createdBy: 1, clientRequestId: 1 }, { unique: true }),
    db
      .collection("eInvoices")
      .createIndex({ sourceType: 1, sourceId: 1, createdAt: -1 }),
    ensureStableOptionalStringUniqueIndex(
      db,
      "eInvoices",
      "myInvoisSubmissionUid",
    ),
    db
      .collection("eInvoices")
      .createIndex({ status: 1, myInvoisStatusCheckedAt: -1 }),
    db
      .collection("scannerSessions")
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db
      .collection("scannerSessions")
      .createIndex({ createdBy: 1, expiresAt: -1 }),
    db
      .collection("paymentDisplaySessions")
      .createIndex({ tokenHash: 1 }, { unique: true }),
    db
      .collection("paymentDisplaySessions")
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db
      .collection("paymentDisplaySessions")
      .createIndex({ createdBy: 1, expiresAt: -1 }),
    db
      .collection("scannerEvents")
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db
      .collection("scannerEvents")
      .createIndex({ scannerSessionId: 1, consumedAt: 1, createdAt: 1 }),
    db.collection("scannerEvents").createIndex({
      scannerSessionId: 1,
      consumedAt: 1,
      claimExpiresAt: 1,
      createdAt: 1,
    }),
    db
      .collection("stocktakes")
      .createIndex({ stocktakeNo: 1 }, { unique: true }),
    db.collection("stocktakes").createIndex({ createdAt: -1 }),
    db.collection("suppliers").createIndex({ code: 1 }, { unique: true }),
    db.collection("suppliers").createIndex({ active: 1, name: 1 }),
    db
      .collection("purchaseOrders")
      .createIndex({ purchaseOrderNo: 1 }, { unique: true }),
    db
      .collection("purchaseOrders")
      .createIndex({ clientRequestId: 1 }, { unique: true }),
    db
      .collection("purchaseOrders")
      .createIndex({ supplierId: 1, status: 1, expectedDate: 1 }),
    db
      .collection("purchaseOrders")
      .createIndex({ locationId: 1, status: 1, createdAt: -1 }),
    db
      .collection("goodsReceipts")
      .createIndex({ receiptNo: 1 }, { unique: true }),
    db
      .collection("goodsReceipts")
      .createIndex({ clientRequestId: 1 }, { unique: true }),
    db
      .collection("goodsReceipts")
      .createIndex({ purchaseOrderId: 1, createdAt: -1 }),
    db
      .collection("goodsReceipts")
      .createIndex({ "items.lotKey": 1, receivedAt: -1 }),
    db
      .collection("accountsPayableBills")
      .createIndex({ billNo: 1 }, { unique: true }),
    db
      .collection("accountsPayableBills")
      .createIndex(
        { supplierId: 1, supplierInvoiceNoNormalized: 1 },
        { unique: true },
      ),
    db
      .collection("accountsPayableBills")
      .createIndex({ status: 1, dueDate: 1 }),
    db
      .collection("supplierPayments")
      .createIndex({ paymentNo: 1 }, { unique: true }),
    db
      .collection("supplierPayments")
      .createIndex({ clientRequestId: 1 }, { unique: true }),
    db.collection("supplierPayments").createIndex(
      { paymentAccountCode: 1, referenceNormalized: 1 },
      {
        unique: true,
        partialFilterExpression: { referenceNormalized: { $type: "string" } },
      },
    ),
    db.collection("supplierPayments").createIndex({ billId: 1, paidAt: -1 }),
    db
      .collection("ownershipTransfers")
      .createIndex({ status: 1, createdAt: -1 }),
    db
      .collection("authThrottle")
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db
      .collection("sensitiveLookupEvents")
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db
      .collection("sensitiveLookupEvents")
      .createIndex({ actorId: 1, createdAt: -1 }),
  ]);

  await migrations.updateOne(
    { _id: INDEX_SCHEMA_VERSION },
    {
      $set: {
        completedAt: new Date(),
        description: "Atlas M0 and Vercel serverless index baseline",
      },
    },
    { upsert: true },
  );
}

export async function getDb() {
  const { dbName, collectionPrefix } = getConfig();
  const client = await getMongoClient();
  const db = scopeCollections(client.db(dbName), collectionPrefix);
  mongoCache.__konkonMongo ??= {};
  mongoCache.__konkonMongo.indexPromise ??= initializeIndexes(db).catch(
    (error) => {
      mongoCache.__konkonMongo!.indexPromise = undefined;
      throw error;
    },
  );
  await mongoCache.__konkonMongo.indexPromise;
  return db;
}
