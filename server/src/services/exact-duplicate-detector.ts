import { createWriteStream, createReadStream } from "node:fs";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import os from "node:os";
import path from "node:path";

export interface DuplicateScanColumn {
  name: string;
}

export interface ExactDuplicateCounts {
  duplicateRows: number;
  duplicateKeyRows: number;
}

export interface ExactDuplicateScanOptions {
  /** Bounds the in-memory sort buffer. Intended mainly for deterministic tests. */
  maxChunkEntries?: number;
  /** Bounds encoded key bytes held by a sort buffer; one oversized row is flushed alone. */
  maxChunkBytes?: number;
  /** Bounds the number of simultaneously open inputs during a merge. */
  mergeFanIn?: number;
  temporaryDirectory?: string;
}

const DEFAULT_MAX_CHUNK_ENTRIES = 20_000;
const DEFAULT_MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_MERGE_FAN_IN = 16;

function identityForRow(
  row: Record<string, unknown>,
  columns: readonly DuplicateScanColumn[],
  primaryKey?: string,
): string {
  const keyValue = primaryKey ? row[primaryKey] : undefined;
  if (keyValue !== null && keyValue !== undefined) {
    // Preserve type so numeric 1 and textual "1" remain distinct keys.
    return `pk:${JSON.stringify([typeof keyValue, keyValue])}`;
  }
  // Column order is defined by the profiled schema, so this is a canonical,
  // exact row identity even if object property order differs between parsers.
  return `row:${JSON.stringify(columns.map(({ name }) => row[name]))}`;
}

async function* readSortedKeys(filePath: string): AsyncGenerator<string> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      yield JSON.parse(line) as string;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

async function writeWithBackpressure(stream: ReturnType<typeof createWriteStream>, value: string): Promise<void> {
  if (!stream.write(value)) await once(stream, "drain");
}

async function writeSortedRun(filePath: string, identities: string[]): Promise<void> {
  const output = createWriteStream(filePath, { encoding: "utf8", flags: "wx", mode: 0o600 });
  const outputFinished = finished(output);
  try {
    for (const identity of identities) {
      await writeWithBackpressure(output, `${JSON.stringify(identity)}\n`);
    }
    output.end();
    await outputFinished;
  } catch (error) {
    output.destroy(error instanceof Error ? error : new Error(String(error)));
    await outputFinished.catch(() => undefined);
    throw error;
  }
}

async function mergeSortedFiles(inputPaths: string[], outputPath: string): Promise<void> {
  const iterators = inputPaths.map((filePath) => readSortedKeys(filePath)[Symbol.asyncIterator]());
  const current = await Promise.all(iterators.map(async (iterator) => (await iterator.next()).value));
  const output = createWriteStream(outputPath, { encoding: "utf8", flags: "wx", mode: 0o600 });
  const outputFinished = finished(output);

  try {
    while (true) {
      let smallestIndex = -1;
      for (let index = 0; index < current.length; index += 1) {
        const candidate = current[index];
        if (candidate !== undefined && (smallestIndex < 0 || candidate < current[smallestIndex]!)) {
          smallestIndex = index;
        }
      }
      if (smallestIndex < 0) break;

      await writeWithBackpressure(output, `${JSON.stringify(current[smallestIndex])}\n`);
      current[smallestIndex] = (await iterators[smallestIndex].next()).value;
    }
    output.end();
    await outputFinished;
  } catch (error) {
    output.destroy(error instanceof Error ? error : new Error(String(error)));
    await outputFinished.catch(() => undefined);
    throw error;
  } finally {
    await Promise.all(iterators.map((iterator) => iterator.return?.(undefined)));
  }
}

/**
 * Count exact duplicate primary keys (or complete rows where no key exists)
 * with bounded RAM. Sorted identity runs spill to a private temporary folder
 * and are merged with bounded fan-in. Temporary data is removed on success or
 * failure; inability to complete the scan is surfaced to the caller.
 */
export async function countExactDuplicates(
  rows: AsyncIterable<Record<string, unknown>>,
  columns: readonly DuplicateScanColumn[],
  primaryKey?: string,
  options: ExactDuplicateScanOptions = {},
): Promise<ExactDuplicateCounts> {
  const maxChunkEntries = options.maxChunkEntries ?? DEFAULT_MAX_CHUNK_ENTRIES;
  const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  const mergeFanIn = options.mergeFanIn ?? DEFAULT_MERGE_FAN_IN;
  if (!Number.isSafeInteger(maxChunkEntries) || maxChunkEntries < 1) {
    throw new Error("Exact duplicate scan chunk size must be a positive integer");
  }
  if (!Number.isSafeInteger(mergeFanIn) || mergeFanIn < 2) {
    throw new Error("Exact duplicate scan merge fan-in must be at least two");
  }
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1) {
    throw new Error("Exact duplicate scan chunk byte limit must be a positive integer");
  }

  const directory = await mkdtemp(path.join(options.temporaryDirectory || os.tmpdir(), "paperclip-duplicate-scan-"));
  const chunks: string[] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;
  let fileSequence = 0;

  const flushChunk = async () => {
    if (chunk.length === 0) return;
    chunk.sort();
    const filePath = path.join(directory, `run-${fileSequence++}.jsonl`);
    await writeSortedRun(filePath, chunk);
    chunks.push(filePath);
    chunk = [];
    chunkBytes = 0;
  };

  try {
    for await (const row of rows) {
      const identity = identityForRow(row, columns, primaryKey);
      const identityBytes = Buffer.byteLength(JSON.stringify(identity), "utf8") + 1;
      if (chunk.length > 0 && (chunk.length >= maxChunkEntries || chunkBytes + identityBytes > maxChunkBytes)) {
        await flushChunk();
      }
      chunk.push(identity);
      chunkBytes += identityBytes;
      if (chunk.length >= maxChunkEntries || chunkBytes >= maxChunkBytes) await flushChunk();
    }
    await flushChunk();

    let pass = 0;
    let activeRuns = chunks;
    while (activeRuns.length > 1) {
      const nextRuns: string[] = [];
      for (let offset = 0; offset < activeRuns.length; offset += mergeFanIn) {
        const group = activeRuns.slice(offset, offset + mergeFanIn);
        if (group.length === 1) {
          nextRuns.push(group[0]);
          continue;
        }

        const mergedPath = path.join(directory, `merge-${pass}-${fileSequence++}.jsonl`);
        await mergeSortedFiles(group, mergedPath);
        nextRuns.push(mergedPath);
        await Promise.all(group.map((filePath) => unlink(filePath)));
      }
      activeRuns = nextRuns;
      pass += 1;
    }

    const counts: ExactDuplicateCounts = { duplicateRows: 0, duplicateKeyRows: 0 };
    let previousIdentity: string | undefined;
    if (activeRuns[0]) {
      for await (const identity of readSortedKeys(activeRuns[0])) {
        if (identity === previousIdentity) {
          counts.duplicateRows += 1;
          if (identity.startsWith("pk:")) counts.duplicateKeyRows += 1;
        }
        previousIdentity = identity;
      }
    }
    return counts;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
