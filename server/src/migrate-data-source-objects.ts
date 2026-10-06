import { createDb } from "@paperclipai/db";
import { DataSourceStorageMigrationService } from "./services/data-source-storage-migration.js";

function parseArguments(args: string[]): { roots: string[]; apply: boolean; limit?: number; help: boolean } {
  const roots: string[] = [];
  let apply = false;
  let limit: number | undefined;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") apply = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--root") {
      const value = args[++index];
      if (!value) throw new Error("--root requires an absolute path");
      roots.push(value);
    } else if (arg === "--limit") {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("--limit requires a positive safe integer");
      limit = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { roots, apply, limit, help };
}

async function main(): Promise<void> {
  let options: ReturnType<typeof parseArguments>;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Invalid command arguments"}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write([
      "Usage: node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/migrate-data-source-objects.js --root <absolute-directory> [--root <directory> ...] [--limit <count>] [--apply]",
      "Defaults to a read-only dry run. --apply copies and verifies each file in MinIO, then compare-and-set updates its PostgreSQL pointer.",
      "Original local files are retained. Restarting after interruption is safe because object keys are deterministic by source ID and SHA-256.",
    ].join("\n") + "\n");
    return;
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl || !process.env.DATASOURCE_OBJECT_STORAGE_ENDPOINT?.trim()) {
    process.stderr.write("DATABASE_URL and datasource object-storage configuration are required.\n");
    process.exitCode = 2;
    return;
  }
  const db = createDb(databaseUrl);
  try {
    const summary = await new DataSourceStorageMigrationService(db).run({
      roots: options.roots,
      apply: options.apply,
      limit: options.limit,
    });
    process.stdout.write(`${JSON.stringify({ mode: options.apply ? "apply" : "dry-run", ...summary }, null, 2)}\n`);
    if (summary.failed > 0 || summary.conflicted > 0) process.exitCode = 1;
  } catch {
    process.stderr.write("Datasource object migration failed. Check the allowed roots, object-storage connectivity, and database state.\n");
    process.exitCode = 1;
  } finally {
    await db.$client.end({ timeout: 2 });
  }
}

await main();
