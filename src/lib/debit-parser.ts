/* ------------------------------------------------------------------ *
 * Debit extraction engine — completely separate from the UPI credit
 * parser. Supports UPI, IMPS, NEFT and RTGS debits, bank independent.
 * Nothing in this file is imported by the credit engine.
 * ------------------------------------------------------------------ */

import { detectColumns, extractDate, type ColumnMap, type Row } from "./upi-parser";

export type DebitMode = "UPI" | "IMPS" | "NEFT" | "RTGS";

export type DebitTxn = {
  date: string;
  utr: string;
  amount: string;
  mode: DebitMode;
};

export type DebitResult = {
  rows: DebitTxn[];
};

/* ---------------------------- vocabulary --------------------------- */

const MODE_PATTERNS: Array<{ mode: DebitMode; re: RegExp }> = [
  { mode: "RTGS", re: /\brtgs\b|rtgs[\s/\-:_]/i },
  { mode: "NEFT", re: /\b(neft|ibneft|eneft)\b|neft[\s/\-:_]/i },
  { mode: "IMPS", re: /\bimps\b|imps[\s/\-:_]/i },
  { mode: "UPI", re: /\bupi\b|upi[\s/\-:_]|\bbhim\b/i },
];

const EXCLUDE_RE =
  /\b(atm|cash\s*wdl|cash\s*withdrawal|cheque|chq|clg|card\s*payment|pos\s|debit\s*card|credit\s*card|charges?|gst|interest|emi|ecs\b|ach\b)\b/i;

const DEBIT_WORDS =
  /\b(dr|debit|debits|debited|withdraw|withdrawal|withdrawals|withdrawn|sent|paid|payment|payments|transfer\s*out|outgoing|outward|out)\b/i;
const CREDIT_WORDS =
  /\b(cr|credit|credits|credited|deposit|deposits|received|incoming|inward|in)\b/i;
const BALANCE_WORDS = /\b(balance|bal|closing|running|available)\b/i;

const REF_KEYWORDS = /(utr|rrn|ref(?:erence)?(?:\s*(?:no|num|number))?|txn\s*id|transaction\s*id|trn)/i;
const BAD_REF_CONTEXT =
  /(a\/?c|acct|account|ben(?:eficiary)?|mobile|phone|ifsc|vpa|balance|bal\b|amount|amt)/i;

/* ------------------------------ money ------------------------------ */

const MONEY_RE = /(?<![\d.])(\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?!\d)/g;

function toNumber(s: string) {
  return Number(s.replace(/,/g, ""));
}

function moneyTokens(text: string): string[] {
  const cleaned = text
    .replace(/\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}/g, " ")
    .replace(/(?<!\d)\d{7,}(?!\d)/g, " ")
    .replace(/(?<!\d)\d{5,6}(?![\d.,])/g, " ");
  return cleaned.match(MONEY_RE) ?? [];
}

function cellAmount(cell: string): number | null {
  const t = moneyTokens(cell);
  if (!t.length) return null;
  const n = toNumber(t[t.length - 1] ?? "");
  return Number.isFinite(n) ? n : null;
}

function fmtAmount(n: number) {
  return n.toFixed(2);
}

/* --------------------------- mode detect --------------------------- */

export function detectMode(text: string): DebitMode | null {
  for (const { mode, re } of MODE_PATTERNS) if (re.test(text)) return mode;
  return null;
}

/* -------------------------- reference pick -------------------------- */

type Candidate = { value: string; index: number };

function candidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  const re = /(?<![A-Za-z0-9])([A-Za-z0-9]{8,32})(?![A-Za-z0-9])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const v = m[1] ?? "";
    if (!/\d/.test(v)) continue; // pure words are not references
    if (/^\d+\.\d+$/.test(v)) continue;
    out.push({ value: v, index: m.index });
  }
  return out;
}

/**
 * Choose the best reference for a debit row: prefer candidates right after an
 * explicit UTR/RRN/Ref keyword, then ones near the mode keyword.
 */
export function extractDebitRef(text: string, mode: DebitMode): string | null {
  const list = candidates(text);
  if (!list.length) return null;

  const modeRe = MODE_PATTERNS.find((p) => p.mode === mode)?.re;
  const modeIdx = modeRe ? text.search(modeRe) : -1;

  const scored = list.map((c) => {
    const before = text.slice(Math.max(0, c.index - 28), c.index);
    let score = 0;
    if (REF_KEYWORDS.test(before)) score += 100;
    if (BAD_REF_CONTEXT.test(before)) score -= 120;
    if (/^\d{12}$/.test(c.value)) score += 40;
    if (/^[A-Za-z]{2,6}\d{6,}$/.test(c.value)) score += 45; // bank prefixed UTR
    if (/^\d{16,}$/.test(c.value)) score -= 25; // account-like
    if (/^\d{10}$/.test(c.value)) score -= 20; // phone-like
    if (/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(c.value)) score -= 200; // IFSC
    if (modeIdx >= 0) {
      const d = Math.abs(c.index - modeIdx);
      score += Math.max(0, 40 - Math.floor(d / 6));
    }
    return { c, score };
  });

  scored.sort((a, b) => b.score - a.score || a.c.index - b.c.index);
  const best = scored[0];
  if (!best || best.score <= 0) return null;
  return best.c.value;
}

/* ------------------------------ engine ------------------------------ */

function rowValues(cells: Row, cols: ColumnMap | null): Array<{ index: number; value: number }> {
  if (cells.length === 1) {
    return moneyTokens(cells[0] || "").map((t, i) => ({ index: i, value: toNumber(t) }));
  }
  const out: Array<{ index: number; value: number }> = [];
  cells.forEach((cell, i) => {
    if (cols?.date === i || cols?.narration === i) return;
    const v = cellAmount(cell || "");
    if (v !== null) out.push({ index: i, value: v });
  });
  return out;
}

function analyzeDebits(rowsIn: Row[]): DebitResult {
  const results: DebitTxn[] = [];
  let cols: ColumnMap | null = null;
  let headerLen = 0;
  let prevBalance: number | null = null;

  for (const raw of rowsIn) {
    const cells = raw.map((c) => (c == null ? "" : String(c).replace(/\s+/g, " ").trim()));
    const text = cells.join(" ").trim();
    if (!text) continue;

    if (/\b(opening\s*balance|balance\s*b\/?f|brought\s*forward|b\/f)\b/i.test(text)) {
      const t = moneyTokens(text);
      if (t.length) prevBalance = toNumber(t[t.length - 1] ?? "");
      continue;
    }

    const maybeHeader = detectColumns(cells);
    if (maybeHeader && extractDate(text) === null) {
      cols = maybeHeader;
      headerLen = cells.length;
      continue;
    }

    const rowCols = cols && cells.length === headerLen ? cols : null;
    const dateCell = rowCols?.date !== undefined ? cells[rowCols.date] || "" : "";
    const date = extractDate(dateCell) ?? extractDate(cells[0] || "") ?? extractDate(text);
    if (!date) continue;

    // ---- balance tracking (needed for the chain even on skipped rows) ----
    const values = rowValues(cells, rowCols);
    let balance: number | null = null;
    let balanceIdx: number | null = null;
    if (rowCols?.balance !== undefined) {
      const v = cellAmount(cells[rowCols.balance] || "");
      if (v !== null) {
        balance = v;
        balanceIdx = rowCols.balance;
      }
    } else if (values.length >= 2) {
      const last = values[values.length - 1]!;
      balance = last.value;
      balanceIdx = last.index;
    }
    const nonBalance = values.filter((v) => v.index !== balanceIdx && v.value > 0);
    const delta =
      balance !== null && prevBalance !== null ? Number((balance - prevBalance).toFixed(2)) : null;
    const prev = prevBalance;
    if (balance !== null) prevBalance = balance;

    if (EXCLUDE_RE.test(text)) continue;
    const mode = detectMode(text);
    if (!mode) continue;

    // ---- debit evidence & amount ----
    let isDebit = false;
    let amount: number | null = null;

    const debitCell = rowCols?.debit !== undefined ? cellAmount(cells[rowCols.debit] || "") : null;
    const creditCell =
      rowCols?.credit !== undefined ? cellAmount(cells[rowCols.credit] || "") : null;
    if (debitCell && debitCell > 0) {
      isDebit = true;
      amount = debitCell;
    } else if (creditCell && creditCell > 0) {
      continue; // this row is a credit
    }

    const typeCell = rowCols?.type !== undefined ? cells[rowCols.type] || "" : "";
    const indicator =
      typeCell || cells.find((c) => /^\s*(cr|dr|c|d)\.?\s*$/i.test(c || "")) || "";
    if (!isDebit && indicator) {
      if (DEBIT_WORDS.test(indicator) && !CREDIT_WORDS.test(indicator)) isDebit = true;
      else if (CREDIT_WORDS.test(indicator)) continue;
    }

    if (delta !== null && Math.abs(delta) > 0) {
      const match = nonBalance.find((v) => Math.abs(v.value - Math.abs(delta)) < 0.02);
      if (match) {
        if (delta > 0) continue; // balance increased → credit
        isDebit = true;
        amount = amount ?? match.value;
      }
    }

    if (!isDebit) {
      const narration = text.replace(BALANCE_WORDS, " ");
      const d = DEBIT_WORDS.test(narration);
      const c = CREDIT_WORDS.test(narration);
      if (d && !c) isDebit = true;
    }
    if (!isDebit) continue;

    if (amount === null && rowCols?.amount !== undefined) {
      amount = cellAmount(cells[rowCols.amount] || "");
    }
    if (amount === null) {
      if (nonBalance.length === 1) amount = nonBalance[0]!.value;
      else if (nonBalance.length > 1) amount = nonBalance[0]!.value;
    }
    if (!amount || amount <= 0) continue;
    if (prev !== null && balance !== null && Math.abs(amount - balance) < 0.001 && nonBalance.length === 0)
      continue;

    const utr = extractDebitRef(text, mode);
    if (!utr) continue;

    results.push({ date, utr, amount: fmtAmount(amount), mode });
  }

  return { rows: dedupeDebits(results) };
}

/* ------------------------------ inputs ------------------------------ */

function stitchLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\u00a0/g, " ").trimEnd();
    if (!line.trim()) continue;
    if (extractDate(line) !== null || out.length === 0) out.push(line);
    else out[out.length - 1] += " " + line.trim();
  }
  return out;
}

function lineToCells(line: string): Row {
  if (line.includes("|")) return line.split("|").map((p) => p.trim());
  if (line.includes("\t")) return line.split("\t").map((p) => p.trim());
  const bySpaces = line.split(/\s{2,}/).map((p) => p.trim());
  if (bySpaces.length >= 3) return bySpaces;
  return [line.trim()];
}

export function parseDebitsFromText(text: string): DebitResult {
  return analyzeDebits(stitchLines(text.split(/\r?\n/)).map(lineToCells));
}

export function parseDebitsFromRows(rows: Row[]): DebitResult {
  return analyzeDebits(rows.map((r) => r.map((c) => (c == null ? "" : String(c)))));
}

export function mergeDebitResults(list: DebitResult[]): DebitResult {
  return { rows: dedupeDebits(list.flatMap((r) => r.rows)) };
}

function dedupeDebits(list: DebitTxn[]): DebitTxn[] {
  const seen = new Set<string>();
  return list.filter((r) => {
    const k = `${r.date}|${r.utr}|${r.amount}|${r.mode}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ----------------------------- reporting ----------------------------- */

export type ModeBreakdown = { mode: DebitMode; volume: number; count: number };

export function debitBreakdown(rows: DebitTxn[]): ModeBreakdown[] {
  const modes: DebitMode[] = ["UPI", "IMPS", "NEFT", "RTGS"];
  return modes.map((mode) => {
    const list = rows.filter((r) => r.mode === mode);
    return {
      mode,
      volume: list.reduce((s, r) => s + Number(r.amount), 0),
      count: list.length,
    };
  });
}

export function toDebitCsv(rows: DebitTxn[]): string {
  return [
    "Date,UTR,Amount,Mode",
    ...rows.map((r) => `${r.date},${r.utr},${r.amount},${r.mode}`),
  ].join("\n");
}

export function timestampName(prefix: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${prefix}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}.csv`;
}
