import { CollectionOptions, Db, MongoClient, ServerApiVersion } from "mongodb";

type MongoCache = {
  clientPromise?: Promise<MongoClient>;
  indexPromise?: Promise<void>;
};

const mongoCache = globalThis as typeof globalThis & { __konkonMongo?: MongoCache };

function getConfig() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME || "konkon_matcha_accounting";
  const collectionPrefix = process.env.MONGODB_COLLECTION_PREFIX?.trim() || "konkon_";

  if (!uri) {
    throw new Error("MONGODB_URI is not configured.");
  }
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(collectionPrefix)) {
    throw new Error("MONGODB_COLLECTION_PREFIX is invalid.");
  }

  return { uri, dbName, collectionPrefix };
}

export function scopedCollectionName(name: string, prefix = process.env.MONGODB_COLLECTION_PREFIX?.trim() || "konkon_") {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(prefix)) throw new Error("MONGODB_COLLECTION_PREFIX is invalid.");
  return `${prefix}${name}`;
}

function scopeCollections(db: Db, prefix: string) {
  return new Proxy(db, {
    get(target, property) {
      if (property === "collection") {
        return (name: string, options?: CollectionOptions) => target.collection(scopedCollectionName(name, prefix), options);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
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
      serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
    });
    mongoCache.__konkonMongo.clientPromise = client.connect();
  }

  return mongoCache.__konkonMongo.clientPromise;
}

async function initializeIndexes(db: Db) {
  await Promise.all([
    db.collection("users").createIndex({ usernameNormalized: 1 }, { unique: true }),
    db.collection("users").createIndex(
      { emailNormalized: 1 },
      { unique: true, partialFilterExpression: { emailNormalized: { $type: "string" } } },
    ),
    db.collection("products").createIndex({ sku: 1 }, { unique: true }),
    db.collection("products").createIndex(
      { barcode: 1 },
      { unique: true, partialFilterExpression: { barcode: { $type: "string" } } },
    ),
    db.collection("products").createIndex({ category: 1, name: 1 }),
    db.collection("members").createIndex({ memberNo: 1 }, { unique: true }),
    db.collection("members").createIndex(
      { memberCardCode: 1 },
      { unique: true, partialFilterExpression: { memberCardCode: { $type: "string" } } },
    ),
    db.collection("members").createIndex(
      { identityLookupHash: 1 },
      { unique: true, partialFilterExpression: { identityLookupHash: { $type: "string" } } },
    ),
    db.collection("members").createIndex(
      { phone: 1 },
      { unique: true, partialFilterExpression: { phone: { $type: "string" } } },
    ),
    db.collection("sales").createIndex({ receiptNo: 1 }, { unique: true }),
    db.collection("sales").createIndex(
      { clientRequestId: 1 },
      { unique: true, partialFilterExpression: { clientRequestId: { $type: "string" } } },
    ),
    db.collection("sales").createIndex({ createdAt: -1 }),
    db.collection("settingsHistory").createIndex({ key: 1, createdAt: -1 }),
    db.collection("locations").createIndex({ code: 1 }, { unique: true }),
    db.collection("locations").createIndex({ systemKey: 1 }, { unique: true, sparse: true }),
    db.collection("locations").createIndex({ parentLocationId: 1, active: 1 }),
    db.collection("locations").createIndex({ countryCode: 1, type: 1, active: 1 }),
    db.collection("receiptTemplates").createIndex({ nameNormalized: 1 }, { unique: true }),
    db.collection("receiptTemplates").createIndex({ systemKey: 1 }, { unique: true, sparse: true }),
    db.collection("receiptTemplates").createIndex({ isDefault: -1, updatedAt: -1 }),
    db.collection("refunds").createIndex({ refundNo: 1 }, { unique: true }),
    db.collection("refunds").createIndex({ saleId: 1, createdAt: -1 }),
    db.collection("journalEntries").createIndex({ entryNo: 1 }, { unique: true }),
    db.collection("invoices").createIndex({ invoiceNo: 1 }, { unique: true }),
    db.collection("invoices").createIndex({ dueDate: 1, status: 1 }),
    db.collection("invoiceTemplates").createIndex({ nameNormalized: 1 }, { unique: true }),
    db.collection("invoiceTemplates").createIndex({ systemKey: 1 }, { unique: true, sparse: true }),
    db.collection("invoiceTemplates").createIndex({ isDefault: -1, updatedAt: -1 }),
    db.collection("auditLogs").createIndex({ createdAt: -1 }),
    db.collection("auditLogs").createIndex({ actorId: 1, createdAt: -1 }),
    db.collection("coupons").createIndex({ code: 1 }, { unique: true }),
    db.collection("coupons").createIndex({ active: 1, expiresAt: 1 }),
    db.collection("couponRedemptions").createIndex({ couponId: 1, memberId: 1, createdAt: -1 }),
    db.collection("couponRedemptions").createIndex({ saleId: 1 }, { unique: true }),
    db.collection("paymentMethods").createIndex({ code: 1 }, { unique: true }),
    db.collection("paymentMethods").createIndex({ systemKey: 1 }, { unique: true, sparse: true }),
    db.collection("paymentMethods").createIndex({ active: 1, sortOrder: 1 }),
    db.collection("exchangeRates").createIndex({ baseCurrency: 1, quoteCurrency: 1 }, { unique: true }),
    db.collection("exchangeRates").createIndex({ active: 1, updatedAt: -1 }),
    db.collection("paymentIntents").createIndex({ intentNo: 1 }, { unique: true }),
    db.collection("paymentIntents").createIndex({ createdBy: 1, status: 1, expiresAt: 1 }),
    db.collection("paymentIntents").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 86_400 }),
    db.collection("paymentConfirmations").createIndex({ provider: 1, externalReference: 1 }, { unique: true }),
    db.collection("paymentConfirmations").createIndex({ verificationCodeHash: 1 }, { unique: true }),
    db.collection("paymentWebhookEvents").createIndex({ eventId: 1 }, { unique: true }),
    db.collection("paymentWebhookEvents").createIndex({ createdAt: 1 }, { expireAfterSeconds: 2_592_000 }),
    db.collection("scannerSessions").createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection("scannerSessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("scannerSessions").createIndex({ createdBy: 1, expiresAt: -1 }),
    db.collection("scannerEvents").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("scannerEvents").createIndex({ scannerSessionId: 1, consumedAt: 1, createdAt: 1 }),
    db.collection("scannerEvents").createIndex({ scannerSessionId: 1, consumedAt: 1, claimExpiresAt: 1, createdAt: 1 }),
    db.collection("stocktakes").createIndex({ stocktakeNo: 1 }, { unique: true }),
    db.collection("stocktakes").createIndex({ createdAt: -1 }),
    db.collection("ownershipTransfers").createIndex({ status: 1, createdAt: -1 }),
    db.collection("authThrottle").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("sensitiveLookupEvents").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("sensitiveLookupEvents").createIndex({ actorId: 1, createdAt: -1 }),
  ]);
}

export async function getDb() {
  const { dbName, collectionPrefix } = getConfig();
  const client = await getMongoClient();
  const db = scopeCollections(client.db(dbName), collectionPrefix);
  mongoCache.__konkonMongo ??= {};
  mongoCache.__konkonMongo.indexPromise ??= initializeIndexes(db);
  await mongoCache.__konkonMongo.indexPromise;
  return db;
}
