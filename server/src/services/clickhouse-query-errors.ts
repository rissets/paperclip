export function formatClickhouseQueryError(status: number, body: string): string {
  const original = body.trim();
  const unknownIdentifier = original.match(
    /Unknown expression or function identifier\s+[`'\"]?([a-zA-Z_][a-zA-Z0-9_]*)[`'\"]?/i,
  );
  if (!unknownIdentifier) return `ClickHouse query error (${status}): ${original}`;

  const scope = original.match(/\bin scope\s+([^\n]+?)(?:\.\s*\(UNKNOWN_IDENTIFIER\)|\s*\(UNKNOWN_IDENTIFIER\))/i)?.[1]?.trim();
  const scopeHint = scope ? ` in scope "${scope}"` : "";
  return [
    `ClickHouse query error (${status}): ${original}`,
    `Hint: ClickHouse could not resolve identifier "${unknownIdentifier[1]}"${scopeHint}. Check the selected table's verified columns and the current CTE projection/aliases; rewrite with an existing identifier and retry once. Do not substitute a guessed column name.`,
  ].join("\n");
}
