/** Metadata attached out-of-band so it never becomes a ClickHouse data column. */
export const DATA_SOURCE_ROW_CHECKPOINT = Symbol.for("paperclip.data-source.row-checkpoint.v1");

export interface CsvSourceRowCheckpoint {
  byteOffset: number;
  rowNumber: number;
  delimiter: string;
}

export function getCsvSourceRowCheckpoint(row: Record<string, unknown>): CsvSourceRowCheckpoint | undefined {
  const value = (row as Record<PropertyKey, unknown>)[DATA_SOURCE_ROW_CHECKPOINT];
  if (!value || typeof value !== "object") return undefined;
  const checkpoint = value as Partial<CsvSourceRowCheckpoint>;
  if (!Number.isSafeInteger(checkpoint.byteOffset) || checkpoint.byteOffset! < 0
    || !Number.isSafeInteger(checkpoint.rowNumber) || checkpoint.rowNumber! < 1
    || typeof checkpoint.delimiter !== "string" || ![",", ";", "\t", "|"].includes(checkpoint.delimiter)) {
    return undefined;
  }
  return checkpoint as CsvSourceRowCheckpoint;
}

export function attachCsvSourceRowCheckpoint<T extends Record<string, unknown>>(
  row: T,
  checkpoint: CsvSourceRowCheckpoint,
): T {
  Object.defineProperty(row, DATA_SOURCE_ROW_CHECKPOINT, { value: checkpoint, enumerable: false });
  return row;
}
