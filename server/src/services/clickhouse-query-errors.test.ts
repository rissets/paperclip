import { describe, expect, it } from "vitest";
import { formatClickhouseQueryError } from "./clickhouse-query-errors.js";

describe("formatClickhouseQueryError", () => {
  it("keeps the ClickHouse identifier and scope while explaining how to correct it", () => {
    const body = "Code: 47. DB::Exception: Unknown expression or function identifier `sinx` in scope stats AS s. (UNKNOWN_IDENTIFIER) (version 26.8.4.11 (official build))";
    const message = formatClickhouseQueryError(404, body);

    expect(message).toContain(`ClickHouse query error (404): ${body}`);
    expect(message).toContain('identifier "sinx"');
    expect(message).toContain('scope "stats AS s"');
    expect(message).toContain("verified columns and the current CTE projection/aliases");
  });

  it("preserves other ClickHouse errors without adding identifier guidance", () => {
    const body = "Code: 62. DB::Exception: Syntax error";
    expect(formatClickhouseQueryError(400, body)).toBe(`ClickHouse query error (400): ${body}`);
  });
});
