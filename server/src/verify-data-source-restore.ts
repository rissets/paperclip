import { createDb } from "@paperclipai/db";
import { loadConfig } from "./config.js";
import { verifyDataSourceRestore } from "./services/data-source-restore-verifier.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write([
      "Usage: pnpm --filter @paperclipai/server datasource:verify-restore [--batch-size <1-500>]",
      "Read-only application-level reconciliation for datasource file pointers, ClickHouse snapshots, managed credentials, and RAG vectors.",
      "Requires DATABASE_URL and the same datasource object-storage, ClickHouse, and secret-provider settings as the restored Paperclip instance.",
      "The report contains datasource IDs and fixed diagnostic codes only; it never includes credentials, connection strings, or file paths.",
    ].join("\n") + "\n");
    return;
  }

  let batchSize = 100;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--batch-size") throw new Error("Unknown argument");
    const value = Number(args[++index]);
    if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw new Error("--batch-size must be between 1 and 500");
    batchSize = value;
  }

  const config = loadConfig();
  process.env.PAPERCLIP_SECRETS_PROVIDER ??= config.secretsProvider;
  process.env.PAPERCLIP_SECRETS_STRICT_MODE ??= String(config.secretsStrictMode);
  process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE ??= config.secretsMasterKeyFilePath;
  const databaseUrl = process.env.DATABASE_URL?.trim() || config.databaseUrl;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for datasource restore verification");

  const db = createDb(databaseUrl);
  try {
    const report = await verifyDataSourceRestore(db, { batchSize });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.issues.some((issue) => issue.severity === "error")) process.exitCode = 1;
  } catch {
    process.stderr.write("Datasource restore verification could not complete; check database migrations and datasource service connectivity.\n");
    process.exitCode = 1;
  } finally {
    await db.$client.end({ timeout: 3 });
  }
}

void main().catch(() => {
  process.stderr.write("Datasource restore verifier failed. Use --help for requirements.\n");
  process.exitCode = 1;
});
