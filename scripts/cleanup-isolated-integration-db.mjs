import { MongoClient } from "mongodb";

const databaseName = process.env.INTEGRATION_DB_NAME || "";
if (!/^konkon_codex_it_[a-zA-Z0-9_]+$/.test(databaseName)) {
  throw new Error("Refusing cleanup: INTEGRATION_DB_NAME is not an isolated konkon_codex_it_* database.");
}
if (!process.env.MONGODB_URI?.startsWith("mongodb")) throw new Error("MONGODB_URI is unavailable.");

const client = new MongoClient(process.env.MONGODB_URI);
try {
  await client.connect();
  const existing = await client.db().admin().listDatabases({ nameOnly: true });
  if (existing.databases.some((database) => database.name === databaseName)) {
    await client.db(databaseName).dropDatabase();
    console.log(`Removed isolated integration database ${databaseName}.`);
  } else {
    console.log(`Isolated integration database ${databaseName} did not exist.`);
  }
} finally {
  await client.close();
}
