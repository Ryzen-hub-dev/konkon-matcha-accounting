import { Db, MongoClient, ServerApiVersion } from "mongodb";

type MongoCache = {
  clientPromise?: Promise<MongoClient>;
  indexPromise?: Promise<void>;
};

const mongoCache = globalThis as typeof globalThis & { __konkonMongo?: MongoCache };

function getConfig() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME || "konkon_matcha_accounting";

  if (!uri) {
    throw new Error("MONGODB_URI is not configured.");
  }

  return { uri, dbName };
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
    db.collection("users").createIndex({ emailNormalized: 1 }, { unique: true, sparse: true }),
    db.collection("products").createIndex({ sku: 1 }, { unique: true }),
    db.collection("products").createIndex({ name: "text", sku: "text" }),
    db.collection("members").createIndex({ memberNo: 1 }, { unique: true }),
    db.collection("members").createIndex({ phone: 1 }, { unique: true, sparse: true }),
    db.collection("sales").createIndex({ receiptNo: 1 }, { unique: true }),
    db.collection("sales").createIndex({ createdAt: -1 }),
    db.collection("journalEntries").createIndex({ entryNo: 1 }, { unique: true }),
    db.collection("invoices").createIndex({ invoiceNo: 1 }, { unique: true }),
    db.collection("invoices").createIndex({ dueDate: 1, status: 1 }),
    db.collection("auditLogs").createIndex({ createdAt: -1 }),
    db.collection("auditLogs").createIndex({ actorId: 1, createdAt: -1 }),
    db.collection("authThrottle").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}

export async function getDb() {
  const { dbName } = getConfig();
  const client = await getMongoClient();
  const db = client.db(dbName);
  mongoCache.__konkonMongo ??= {};
  mongoCache.__konkonMongo.indexPromise ??= initializeIndexes(db);
  await mongoCache.__konkonMongo.indexPromise;
  return db;
}
