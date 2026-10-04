import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  createDb,
  dataSources,
  dataSourceTables,
  dataSourceRecords,
  dataSourceChunks,
} from "@paperclipai/db";
import { loadConfig } from "./config.js";
import { OnboardingOrchestratorService } from "./services/onboarding-orchestrator.js";
import { DataSourceCollectionsService } from "./services/data-source-collections.js";

async function run() {
  const config = loadConfig();
  const dbUrl = config.databaseUrl || process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not configured");

  console.log(`[Reprocess] Connecting to DB: ${dbUrl.replace(/:[^:@]+@/, ":***@")}`);
  const db = createDb(dbUrl);
  const orchestrator = new OnboardingOrchestratorService(db);
  const collectionsService = new DataSourceCollectionsService(db);

  const stuckSources = await db
    .select()
    .from(dataSources)
    .where(eq(dataSources.status, "processing"));

  console.log(`[Reprocess] Found ${stuckSources.length} sources in 'processing' status.`);

  for (let idx = 0; idx < stuckSources.length; idx++) {
    const ds = stuckSources[idx];
    console.log(`\n[Reprocess] [${idx + 1}/${stuckSources.length}] Starting ${ds.name} (${ds.fileName})...`);

    if (!ds.storagePath || !fs.existsSync(ds.storagePath)) {
      console.warn(`[Reprocess] File not found at ${ds.storagePath}, skipping`);
      continue;
    }

    // Clean up any partial tables/records/chunks for idempotency
    await db.delete(dataSourceRecords).where(eq(dataSourceRecords.dataSourceId, ds.id));
    await db.delete(dataSourceTables).where(eq(dataSourceTables.dataSourceId, ds.id));
    await db.delete(dataSourceChunks).where(eq(dataSourceChunks.dataSourceId, ds.id));

    const fileBuffer = fs.readFileSync(ds.storagePath);
    const file = {
      buffer: fileBuffer,
      originalname: ds.fileName || `${ds.name}.csv`,
      mimetype: ds.mimeType || "text/csv",
      size: ds.fileSize || fileBuffer.length,
    };

    const ext = path.extname(ds.fileName || "").toLowerCase().replace(".", "") || "csv";

    try {
      await (orchestrator as any).executeOnboardingPipeline(
        ds.companyId,
        ds,
        file,
        { collectionId: ds.collectionId ?? undefined, async: false, skipCorrelation: true },
        ds.name,
        ext,
        ds.sourceType,
      );
      console.log(`[Reprocess] ✓ Successfully onboarded: ${ds.name}`);
    } catch (err: any) {
      console.error(`[Reprocess] ✗ Failed to reprocess ${ds.name}:`, err.message);
    }
  }

  // Correlate collections that were touched
  const collectionIds = Array.from(
    new Set(stuckSources.map((s) => s.collectionId).filter(Boolean)),
  ) as string[];

  for (const cid of collectionIds) {
    const companyId = stuckSources.find((s) => s.collectionId === cid)?.companyId;
    if (companyId) {
      console.log(`\n[Reprocess] Correlating collection ${cid}...`);
      try {
        await collectionsService.correlateCollection(companyId, cid);
        console.log(`[Reprocess] ✓ Collection ${cid} correlated.`);
      } catch (err: any) {
        console.warn(`[Reprocess] Correlation warning for ${cid}:`, err.message);
      }
    }
  }

  console.log("\n[Reprocess] Finished all stuck sources!");
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
