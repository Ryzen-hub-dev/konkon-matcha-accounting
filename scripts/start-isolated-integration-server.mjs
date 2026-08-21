import { spawn } from "node:child_process";

const databaseName = process.env.INTEGRATION_DB_NAME || "";
const port = process.env.INTEGRATION_PORT || "3001";

if (!/^konkon_codex_it_[a-zA-Z0-9_]+$/.test(databaseName)) {
  throw new Error("INTEGRATION_DB_NAME must name an isolated konkon_codex_it_* database.");
}
if (!/^\d{4,5}$/.test(port)) throw new Error("INTEGRATION_PORT is invalid.");
if (!process.env.MONGODB_URI?.startsWith("mongodb")) throw new Error("MONGODB_URI is unavailable.");

const env = {
  ...process.env,
  AUTH_SECRET: "codex-integration-auth-secret-20260822-123456",
  IDENTITY_LOOKUP_SECRET: "codex-integration-identity-secret-20260822-654321",
  MONGODB_DB_NAME: databaseName,
  MONGODB_COLLECTION_PREFIX: "it_",
};

const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--port", port], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code) => process.exit(code ?? 0));
