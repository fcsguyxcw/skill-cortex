export const PAGINATION_DETECTOR_SCHEMA_VERSION = "phase3-pagination-finding-v1";
export const PAGINATION_DETECTOR_VERSION = "1.0.0";
export const MAX_SQL_LENGTH = 16_384;

export type PaginationClass =
  | "uses_offset"
  | "uses_keyset"
  | "no_pagination"
  | "abstain";

export interface PaginationFinding {
  class: PaginationClass;
  evidence: { matchText: string };
}

interface Token {
  text: string;
  upper: string;
  start: number;
  end: number;
  kind: "word" | "number" | "parameter" | "operator" | "symbol";
}

interface ScanResult {
  tokens: Token[];
  unsupportedAt?: number;
}

function token(
  sql: string,
  start: number,
  end: number,
  kind: Token["kind"],
): Token {
  const text = sql.slice(start, end);
  return { text, upper: text.toUpperCase(), start, end, kind };
}

function scan(sql: string): ScanResult {
  const tokens: Token[] = [];
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;
    if (/\s/u.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const newline = sql.indexOf("\n", i + 2);
      i = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      if (depth !== 0) return { tokens, unsupportedAt: start };
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const start = i;
      const quote = ch;
      i += 1;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return { tokens, unsupportedAt: start };
      continue;
    }
    if (ch === "[") {
      const start = i;
      i += 1;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === "]") {
          if (sql[i + 1] === "]") {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return { tokens, unsupportedAt: start };
      continue;
    }
    if (ch === "$") {
      const parameter = /^\$\d+/u.exec(sql.slice(i));
      if (parameter !== null) {
        const end = i + parameter[0].length;
        tokens.push(token(sql, i, end, "parameter"));
        i = end;
        continue;
      }
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(i));
      if (delimiter !== null) {
        const start = i;
        const bodyStart = i + delimiter[0].length;
        const close = sql.indexOf(delimiter[0], bodyStart);
        if (close === -1) return { tokens, unsupportedAt: start };
        i = close + delimiter[0].length;
        continue;
      }
      return { tokens, unsupportedAt: i };
    }
    if (/[A-Za-z_]/u.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(sql.slice(i))!;
      const end = i + match[0].length;
      tokens.push(token(sql, i, end, "word"));
      i = end;
      continue;
    }
    if (/\d/u.test(ch)) {
      const match = /^\d+(?:\.\d+)?/u.exec(sql.slice(i))!;
      const end = i + match[0].length;
      tokens.push(token(sql, i, end, "number"));
      i = end;
      continue;
    }
    const pair = sql.slice(i, i + 2);
    if ([">=", "<=", "<>", "!="].includes(pair)) {
      tokens.push(token(sql, i, i + 2, "operator"));
      i += 2;
      continue;
    }
    if ([">", "<", "="].includes(ch)) {
      tokens.push(token(sql, i, i + 1, "operator"));
      i += 1;
      continue;
    }
    if (["(", ")", ",", ";", ".", "+", "-", "*", "/"].includes(ch)) {
      tokens.push(token(sql, i, i + 1, "symbol"));
      i += 1;
      continue;
    }
    return { tokens, unsupportedAt: i };
  }

  return { tokens };
}

function isBoundedCount(token_: Token | undefined): boolean {
  return token_?.kind === "number" || token_?.kind === "parameter";
}

function evidence(sql: string, start: number, end: number): { matchText: string } {
  return { matchText: sql.slice(start, end) };
}

/** Deterministic, in-memory inspection only. It never executes or rewrites SQL. */
export function detectPagination(sql: string): PaginationFinding {
  if (typeof sql !== "string" || sql.length === 0 || sql.length > MAX_SQL_LENGTH) {
    return { class: "abstain", evidence: { matchText: "" } };
  }

  const scanned = scan(sql);
  if (scanned.unsupportedAt !== undefined) {
    return {
      class: "abstain",
      evidence: evidence(sql, scanned.unsupportedAt, Math.min(scanned.unsupportedAt + 1, sql.length)),
    };
  }
  const tokens = scanned.tokens;
  if (tokens.length === 0) return { class: "abstain", evidence: { matchText: "" } };
  if (
    tokens[0]!.kind !== "word" ||
    (tokens[0]!.upper !== "SELECT" && tokens[0]!.upper !== "WITH")
  ) {
    return {
      class: "abstain",
      evidence: evidence(sql, tokens[0]!.start, tokens[0]!.end),
    };
  }

  const semicolons = tokens
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.text === ";");
  if (semicolons.some(({ index }) => index !== tokens.length - 1)) {
    const first = semicolons.find(({ index }) => index !== tokens.length - 1)!.item;
    return { class: "abstain", evidence: evidence(sql, first.start, first.end) };
  }

  const offsets = tokens
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.kind === "word" && item.upper === "OFFSET");
  if (offsets.length > 0) {
    const malformed = offsets.find(({ index }) => !isBoundedCount(tokens[index + 1]));
    if (malformed !== undefined) {
      return {
        class: "abstain",
        evidence: evidence(sql, malformed.item.start, malformed.item.end),
      };
    }
    const first = offsets[0]!;
    const value = tokens[first.index + 1]!;
    return {
      class: "uses_offset",
      evidence: evidence(sql, first.item.start, value.end),
    };
  }

  const fetch = tokens.find((item) => item.kind === "word" && item.upper === "FETCH");
  if (fetch !== undefined) {
    return { class: "abstain", evidence: evidence(sql, fetch.start, fetch.end) };
  }

  const limits = tokens
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.kind === "word" && item.upper === "LIMIT");
  const malformedLimit = limits.find(({ index }) => !isBoundedCount(tokens[index + 1]));
  if (malformedLimit !== undefined) {
    return {
      class: "abstain",
      evidence: evidence(sql, malformedLimit.item.start, malformedLimit.item.end),
    };
  }

  const whereIndex = tokens.findIndex((item) => item.kind === "word" && item.upper === "WHERE");
  const orderIndex = tokens.findIndex(
    (item, index) =>
      item.kind === "word" &&
      item.upper === "ORDER" &&
      tokens[index + 1]?.kind === "word" &&
      tokens[index + 1]?.upper === "BY",
  );
  if (whereIndex >= 0 && orderIndex > whereIndex && limits.some(({ index }) => index > orderIndex)) {
    const comparison = tokens.findIndex(
      (item, index) =>
        index > whereIndex &&
        index < orderIndex &&
        item.kind === "operator" &&
        [">", "<", ">=", "<="].includes(item.text) &&
        (tokens[index - 1]?.kind === "word" || tokens[index - 1]?.text === ")") &&
        (isBoundedCount(tokens[index + 1]) || tokens[index + 1]?.text === "("),
    );
    if (comparison >= 0) {
      const matchText = sql.slice(tokens[whereIndex]!.start, tokens[orderIndex]!.start).trimEnd();
      return {
        class: "uses_keyset",
        evidence: { matchText: matchText || tokens[comparison]!.text },
      };
    }
  }

  return { class: "no_pagination", evidence: evidence(sql, tokens[0]!.start, tokens[0]!.end) };
}
