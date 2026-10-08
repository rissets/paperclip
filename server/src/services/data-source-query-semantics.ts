export interface TemporalColumnMetadata {
  name: string;
  dataType?: string;
  role?: string;
  semanticCategory?: string;
  clickhouseType?: string;
  temporalEncoding?: string;
  dateEncoding?: string;
  sampleValues?: unknown[];
  min?: unknown;
  max?: unknown;
}

export type TemporalRangeResolution =
  | { status: "resolved"; column: string; label: string; gte: string | number; lt: string | number }
  | { status: "not_requested" }
  | { status: "unsafe"; reason: string };

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, januari: 1,
  february: 2, feb: 2, februari: 2,
  march: 3, mar: 3, maret: 3,
  april: 4, apr: 4,
  may: 5, mei: 5,
  june: 6, jun: 6, juni: 6,
  july: 7, jul: 7, juli: 7,
  august: 8, aug: 8, agustus: 8, agu: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, oktober: 10, okt: 10,
  november: 11, nov: 11,
  december: 12, dec: 12, desember: 12, des: 12,
};

function requestedMonth(query: string): { year: number; month: number } | null {
  const normalized = query.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const numeric = normalized.match(/\b(20\d{2})[-/](0?[1-9]|1[0-2])\b/);
  if (numeric) return { year: Number(numeric[1]), month: Number(numeric[2]) };

  for (const [monthName, month] of Object.entries(MONTHS)) {
    const pattern = new RegExp(`\\b${monthName}\\b[\\s,/-]*(20\\d{2})\\b|\\b(20\\d{2})\\b[\\s,/-]*${monthName}\\b`);
    const match = normalized.match(pattern);
    if (match) return { year: Number(match[1] || match[3]), month };
  }
  return null;
}

function numericSamples(column: TemporalColumnMetadata): number[] {
  const values = [
    ...(Array.isArray(column.sampleValues) ? column.sampleValues : []),
    column.min,
    column.max,
  ];
  return values
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(Number)
    .filter(Number.isFinite);
}

function excelSerial(date: Date): number {
  return (date.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/** Parse an explicitly requested month and bind it only to an unambiguous, typed temporal column. */
export function resolveTemporalRangeFilter(
  query: string,
  columns: TemporalColumnMetadata[],
): TemporalRangeResolution {
  const requested = requestedMonth(query);
  if (!requested) return { status: "not_requested" };

  const temporalColumns = columns.filter((column) =>
    column.role === "temporal"
    || column.semanticCategory === "temporal"
    || /(^|_)(date|time|month|period|periode|year|tahun|tanggal|timestamp)(_|$)/i.test(column.name),
  );
  if (temporalColumns.length !== 1) {
    return {
      status: "unsafe",
      reason: temporalColumns.length === 0
        ? "Tidak ditemukan kolom tanggal/periode yang terverifikasi."
        : `Kolom waktu ambigu (${temporalColumns.map((column) => column.name).join(", ")}).`,
    };
  }

  const column = temporalColumns[0];
  const dataType = String(column.dataType || "").toLowerCase();
  const physicalType = String(column.clickhouseType || "").toLowerCase();
  const encoding = String(column.temporalEncoding || column.dateEncoding || "").toLowerCase();
  const startDate = new Date(Date.UTC(requested.year, requested.month - 1, 1));
  const endDate = new Date(Date.UTC(requested.year, requested.month, 1));
  const label = `${startDate.toISOString().slice(0, 7)}`;

  if (dataType === "number" || /int|float|decimal|numeric|uint|(^|\W)number(\W|$)/i.test(physicalType)) {
    const samples = numericSamples(column);
    const plausibleExcelSerial = samples.length > 0
      && samples.every((value) => value >= 20_000 && value <= 80_000);
    const excelMonthColumn = /(^|_)(month|period|periode|tanggal|date)(_|$)/i.test(column.name)
      && (physicalType.includes("float") || dataType === "number");
    if (encoding === "excel_serial" || plausibleExcelSerial || (samples.length === 0 && excelMonthColumn)) {
      return { status: "resolved", column: column.name, label, gte: excelSerial(startDate), lt: excelSerial(endDate) };
    }

    const unixScale = encoding || (samples.length > 0 && samples.every((value) => value >= 100_000_000_000)
      ? "unix_milliseconds"
      : samples.length > 0 && samples.every((value) => value >= 1_000_000_000 && value < 100_000_000_000)
        ? "unix_seconds"
        : "");
    if (unixScale === "unix_seconds") {
      return { status: "resolved", column: column.name, label, gte: startDate.getTime() / 1000, lt: endDate.getTime() / 1000 };
    }
    if (unixScale === "unix_milliseconds" || unixScale === "unix_millis") {
      return { status: "resolved", column: column.name, label, gte: startDate.getTime(), lt: endDate.getTime() };
    }

    return {
      status: "unsafe",
      reason: `Format penyimpanan kolom waktu '${column.name}' tidak dapat dipastikan; query periode tidak dijalankan tanpa filter yang aman.`,
    };
  }

  if (encoding === "iso_string" || /date|datetime|timestamp/i.test(physicalType) || ["date", "datetime", "timestamp"].includes(dataType)) {
    return {
      status: "resolved",
      column: column.name,
      label,
      gte: startDate.toISOString(),
      lt: endDate.toISOString(),
    };
  }

  return {
    status: "unsafe",
    reason: `Format penyimpanan kolom waktu '${column.name}' tidak dapat dipastikan; query periode tidak dijalankan tanpa filter yang aman.`,
  };
}

export interface SemanticMetricBinding {
  name: string;
  column: string;
  synonyms: string[];
}

export interface SemanticDimensionBinding {
  name: string;
  column: string;
  synonyms: string[];
}

export type DimensionResolution =
  | { status: "resolved"; column: string; name: string }
  | { status: "not_requested" }
  | { status: "unmatched" }
  | { status: "ambiguous"; names: string[] };

function normalizeMetricIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeSemanticPhrase(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Bind display dimensions to verified physical columns, retaining explicit synonyms. */
export function resolveSemanticDimensionBindings(
  dimensions: unknown[],
  columns: Array<{ name: string; role?: string }>,
  synonyms: Record<string, unknown> = {},
): SemanticDimensionBinding[] {
  const schemaByName = new Map(columns.map((column) => [column.name.toLowerCase(), column]));
  const bindings = (Array.isArray(dimensions) ? dimensions : []).flatMap((rawDimension) => {
    const dimension = typeof rawDimension === "string" ? { name: rawDimension } : rawDimension as Record<string, unknown>;
    const name = typeof dimension?.name === "string" ? dimension.name.trim() : "";
    if (!name) return [];

    const declaredColumn = typeof dimension.column === "string" ? dimension.column : undefined;
    const direct = (declaredColumn && schemaByName.get(declaredColumn.toLowerCase()))
      || schemaByName.get(name.toLowerCase());
    let physicalColumn = direct?.name;
    if (!physicalColumn) {
      const identity = normalizeMetricIdentity(name);
      const matches = columns.filter((column) => {
        const candidate = normalizeMetricIdentity(column.name);
        return candidate === identity || candidate.startsWith(identity) || identity.startsWith(candidate);
      });
      if (matches.length === 1) physicalColumn = matches[0].name;
    }

    const dimensionSynonyms = Array.isArray(dimension.synonyms) ? dimension.synonyms : synonyms[name];
    const synonymList = Array.isArray(dimensionSynonyms)
      ? dimensionSynonyms.filter((value): value is string => typeof value === "string")
      : [];
    return physicalColumn ? [{ name, column: physicalColumn, synonyms: synonymList }] : [];
  });

  const boundColumns = new Set(bindings.map((binding) => binding.column.toLowerCase()));
  for (const column of columns) {
    if (column.role === "dimension" && !boundColumns.has(column.name.toLowerCase())) {
      bindings.push({ name: column.name, column: column.name, synonyms: [] });
      boundColumns.add(column.name.toLowerCase());
    }
  }
  return bindings;
}

/** Match a requested grouping dimension only when the question names it explicitly. */
export function resolveRequestedDimension(
  query: string,
  bindings: SemanticDimensionBinding[],
): DimensionResolution {
  const normalizedQuery = query
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.!?;\n]+/g, " | ")
    .replace(/[^a-z0-9|]+/g, " ")
    .replace(/\s*\|\s*/g, " | ")
    .trim();
  const negativeInstruction = /\b(?:jangan|jgn|do\s+not|don\s+t|without|tanpa)\b/i;
  const groupingCues = /\b(?:group\s+by|grouped\s+by|breakdown\s+by|berdasarkan|kelompokkan|kelompok|menurut|by|per|each|tiap|setiap)\b/g;
  const groupingSegments: string[] = [];
  const positiveClauses = normalizedQuery
    .split(" | ")
    .map((clause) => clause.split(negativeInstruction, 1)[0]);
  for (const positiveClause of positiveClauses) {
    for (const match of positiveClause.matchAll(groupingCues)) {
      const endOfCue = (match.index || 0) + match[0].length;
      const tail = positiveClause.slice(endOfCue);
      const contextBoundary = tail.search(/\b(?:through|via|using|melalui|menggunakan|dengan|from|dari|where|when|filter(?:ed)?\s+by)\b/i);
      groupingSegments.push(contextBoundary >= 0 ? tail.slice(0, contextBoundary) : tail);
    }
  }
  if (groupingSegments.length === 0) return { status: "not_requested" };

  const matchesBySegment = groupingSegments.map((segment) => bindings.filter((binding) =>
    [binding.name, binding.column, ...binding.synonyms].some((identity) => {
      const normalizedIdentity = normalizeSemanticPhrase(identity);
      return normalizedIdentity.length > 0 && ` ${segment} `.includes(` ${normalizedIdentity} `);
    }),
  ));
  if (matchesBySegment.some((matches) => matches.length === 0)) return { status: "unmatched" };
  const uniqueByColumn = new Map(matchesBySegment.flat().map((binding) => [binding.column.toLowerCase(), binding]));
  const candidates = [...uniqueByColumn.values()];
  if (candidates.length === 1) {
    return { status: "resolved", column: candidates[0].column, name: candidates[0].name };
  }
  return candidates.length > 1
    ? { status: "ambiguous", names: candidates.map((candidate) => candidate.name) }
    : { status: "unmatched" };
}

/** Resolve a model-proposed label only when it maps to one known semantic/physical dimension. */
export function resolveDimensionBinding(
  value: unknown,
  bindings: SemanticDimensionBinding[],
): SemanticDimensionBinding | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const identity = normalizeSemanticPhrase(value);
  const candidates = bindings.filter((binding) =>
    [binding.name, binding.column, ...binding.synonyms].some((candidate) => normalizeSemanticPhrase(candidate) === identity),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Bind human-readable semantic metrics to one verified physical schema column. */
export function resolveSemanticMetricBindings(
  metrics: unknown[],
  columns: Array<{ name: string; role?: string }>,
  synonyms: Record<string, unknown> = {},
): SemanticMetricBinding[] {
  const schemaByName = new Map(columns.map((column) => [column.name.toLowerCase(), column]));
  const metricColumns = columns.filter((column) => column.role === "metric");

  return metrics.flatMap((rawMetric) => {
    const metric = typeof rawMetric === "string" ? { name: rawMetric } : rawMetric as Record<string, unknown>;
    const name = typeof metric?.name === "string" ? metric.name.trim() : "";
    if (!name) return [];

    const declaredColumn = typeof metric.column === "string" ? metric.column : undefined;
    const direct = (declaredColumn && schemaByName.get(declaredColumn.toLowerCase()))
      || schemaByName.get(name.toLowerCase());
    let physicalColumn = direct?.name;
    if (!physicalColumn) {
      const identity = normalizeMetricIdentity(name);
      const normalizedMatches = metricColumns.filter((column) => {
        const candidate = normalizeMetricIdentity(column.name).replace(/(usd|idr|eur|gbp|amount|value|total)$/i, "");
        return candidate === identity || candidate.startsWith(identity) || identity.startsWith(candidate);
      });
      if (normalizedMatches.length === 1) physicalColumn = normalizedMatches[0].name;
    }

    const extraSynonyms = Array.isArray(metric.synonyms) ? metric.synonyms : synonyms[name];
    const synonymList = Array.isArray(extraSynonyms)
      ? extraSynonyms.filter((value): value is string => typeof value === "string")
      : [];
    return physicalColumn ? [{ name, column: physicalColumn, synonyms: synonymList }] : [];
  });
}
