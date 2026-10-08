export interface QueryScopeTable {
  id: string;
  dataSourceId: string;
  tableName: string;
  semanticModel?: unknown;
}

export interface RankedQueryTable {
  id: string;
  relevanceScore?: number;
}

export interface QueryTableScopeResolution<T extends QueryScopeTable> {
  tables: T[] | null;
  referencedTables: string[];
  unresolvedReferences: string[];
  needsClarification: boolean;
}

const GENERIC_TABLE_REFERENCES = new Set([
  "table",
  "table_name",
  "dataset",
  "data",
  "source",
  "source_table",
]);

function normalizeTableIdentity(value: string): string {
  return value.trim().replace(/["'`\[\]]/g, "").toLowerCase();
}

function containsExactIdentifier(query: string, identifier: string): boolean {
  const normalizedQuery = query.toLowerCase();
  const normalizedIdentifier = normalizeTableIdentity(identifier);
  if (!normalizedIdentifier) return false;
  let offset = normalizedQuery.indexOf(normalizedIdentifier);
  while (offset >= 0) {
    const before = normalizedQuery[offset - 1];
    const after = normalizedQuery[offset + normalizedIdentifier.length];
    const isIdentifierPart = (value: string | undefined) => Boolean(value && /[a-z0-9_]/i.test(value));
    if (!isIdentifierPart(before) && !isIdentifierPart(after)) return true;
    offset = normalizedQuery.indexOf(normalizedIdentifier, offset + normalizedIdentifier.length);
  }
  return false;
}

function chooseUniqueRankedTable(
  rankedTables: RankedQueryTable[],
  exactMatchFound: boolean,
): string | undefined {
  const candidates = rankedTables.filter((candidate) => candidate.id);
  if (candidates.length === 0) return undefined;
  if (exactMatchFound) return candidates.length === 1 ? candidates[0].id : undefined;

  const top = candidates[0];
  const topScore = Number(top.relevanceScore || 0);
  const secondScore = Number(candidates[1]?.relevanceScore || 0);
  return topScore >= 0.75 && topScore - secondScore >= 0.2 ? top.id : undefined;
}

/**
 * Resolve Pi's generic `table`/`dataset` placeholder only when authorized
 * schema retrieval identifies one unambiguous physical table. Explicit unknown
 * names stay errors; this function never widens the caller's datasource scope.
 */
export function resolveQueryTableScope<T extends QueryScopeTable>(input: {
  query: string;
  requestedReferences: string[];
  allowedTables: T[];
  rankedTables?: RankedQueryTable[];
  exactMatchFound?: boolean;
}): QueryTableScopeResolution<T> {
  const byName = new Map<string, T>();
  for (const table of input.allowedTables) {
    byName.set(normalizeTableIdentity(table.tableName), table);
    const semanticModel = table.semanticModel as Record<string, unknown> | undefined;
    const schemaName = typeof semanticModel?.schemaName === "string" ? semanticModel.schemaName : undefined;
    if (schemaName) byName.set(`${normalizeTableIdentity(schemaName)}.${normalizeTableIdentity(table.tableName)}`, table);
  }

  const requested = Array.from(new Set(input.requestedReferences.map((name) => name.trim()).filter(Boolean)));
  const exactTables = new Map<string, T>();
  const genericReferences: string[] = [];
  const unresolvedReferences: string[] = [];

  for (const reference of requested) {
    const exact = byName.get(normalizeTableIdentity(reference));
    if (exact) {
      exactTables.set(exact.id, exact);
      continue;
    }
    if (GENERIC_TABLE_REFERENCES.has(normalizeTableIdentity(reference))) {
      genericReferences.push(reference);
    } else {
      unresolvedReferences.push(reference);
    }
  }

  const naturalLanguageMatches = input.allowedTables.filter((table) =>
    !GENERIC_TABLE_REFERENCES.has(normalizeTableIdentity(table.tableName))
    && containsExactIdentifier(input.query, table.tableName),
  );
  const matchesByName = new Map<string, T[]>();
  for (const table of naturalLanguageMatches) {
    const key = normalizeTableIdentity(table.tableName);
    const matches = matchesByName.get(key) || [];
    matches.push(table);
    matchesByName.set(key, matches);
  }
  const ambiguousNaturalName = [...matchesByName.entries()].find(([, matches]) =>
    new Set(matches.map((table) => table.id)).size > 1,
  );
  if (ambiguousNaturalName) {
    const name = naturalLanguageMatches.find((table) => normalizeTableIdentity(table.tableName) === ambiguousNaturalName[0])?.tableName || ambiguousNaturalName[0];
    return {
      tables: null,
      referencedTables: requested,
      unresolvedReferences: [name],
      needsClarification: true,
    };
  }
  for (const table of naturalLanguageMatches) exactTables.set(table.id, table);

  if (unresolvedReferences.length > 0) {
    return { tables: null, referencedTables: requested, unresolvedReferences, needsClarification: true };
  }

  if (genericReferences.length > 0 && exactTables.size === 0) {
    const selectedId = chooseUniqueRankedTable(input.rankedTables || [], Boolean(input.exactMatchFound));
    const selected = selectedId ? input.allowedTables.find((table) => table.id === selectedId) : undefined;
    if (!selected) {
      return {
        tables: null,
        referencedTables: [],
        unresolvedReferences: genericReferences,
        needsClarification: true,
      };
    }
    exactTables.set(selected.id, selected);
  }

  if (exactTables.size > 0) {
    const tables = [...exactTables.values()];
    return {
      tables,
      referencedTables: tables.map((table) => table.tableName),
      unresolvedReferences: [],
      needsClarification: false,
    };
  }

  if (requested.length === 0) {
    const selectedId = chooseUniqueRankedTable(input.rankedTables || [], Boolean(input.exactMatchFound));
    const selected = selectedId ? input.allowedTables.find((table) => table.id === selectedId) : undefined;
    if (selected) {
      return {
        tables: [selected],
        referencedTables: [selected.tableName],
        unresolvedReferences: [],
        needsClarification: false,
      };
    }
  }

  return {
    tables: null,
    referencedTables: requested,
    unresolvedReferences: [],
    needsClarification: false,
  };
}
