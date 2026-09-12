import { loadEnvConfig } from "@next/env";
import { readFileSync } from "node:fs";
import { MongoClient, type Db } from "mongodb";
import { resetOwnerForRecovery } from "../lib/owner-reset";

// Run without --confirm-remove for a read-only identity check. Config files must
// remain outside version control; do not pass credentials as command arguments.
async function main() {
  loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
  const args = process.argv.slice(2);
  const value = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const file = value("--config-file");
  const config = file ? JSON.parse(readFileSync(file, "utf8")) : {
    uri: process.env.MONGODB_URI, dbName: process.env.MONGODB_DB_NAME,
    prefix: process.env.MONGODB_COLLECTION_PREFIX || "konkon_", siteUrl: process.env.NEXT_PUBLIC_APP_URL,
  };
  if (!config.uri || !config.dbName || !/^[a-zA-Z0-9_-]{1,32}$/.test(config.prefix)) throw new Error("Valid database configuration is required.");
  const client = new MongoClient(config.uri, { maxPoolSize: 2, serverSelectionTimeoutMS: 10000, appName: "konkon-authorized-owner-maintenance" });
  try {
    await client.connect();
    const raw = client.db(config.dbName);
    const db = new Proxy(raw, { get(target, property) {
      if (property === "collection") return (name: string) => target.collection(`${config.prefix}${name}`);
      const method = Reflect.get(target, property, target);
      return typeof method === "function" ? method.bind(target) : method;
    } }) as Db;
    const owners = await db.collection("users").find({ role: "OWNER" }, { projection: { username: 1, role: 1, active: 1 } }).toArray();
    const business = await db.collection("settings").findOne({ key: "business" }, { projection: { businessName: 1 } });
    const otherUsers = await db.collection("users").countDocuments({ role: { $ne: "OWNER" } });
    console.log(JSON.stringify({ database: config.dbName, prefix: config.prefix, businessName: business?.businessName, owners, otherUsers }));
    const ownerId = value("--confirm-remove");
    if (!ownerId) return;
    const site = new URL(config.siteUrl);
    if (site.protocol !== "https:" || site.username || site.password || site.pathname !== "/" || site.search || site.hash) throw new Error("An HTTPS application origin is required.");
    // A deployed recovery page is a precondition, never delete first and deploy later.
    const response = await fetch(`${site.origin}/recover-owner`, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    if (response.status !== 200 || !(await response.text()).includes("PRIVATE OWNER RECOVERY")) throw new Error("Deploy and verify the recovery page before removing the Owner.");
    const result = await resetOwnerForRecovery(db, client, ownerId);
    console.log(JSON.stringify({ removedOwnerId: result.removedOwnerId, expiresAt: result.expiresAt,
      privateRecoveryUrl: `${site.origin}/recover-owner#token=${result.token}`,
      note: "Treat this one-time URL as an Owner credential. Do not paste it into tickets or commit it." }));
  } finally { await client.close(); }
}
main().catch(error => {
  // Database errors can embed credentials or documents. Print no driver message.
  console.error(error instanceof Error && error.name === "Error" ? error.message : "Owner maintenance failed; no credentials were logged.");
  process.exitCode = 1;
});
