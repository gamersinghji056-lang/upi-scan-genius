export type UpiCredit = {
  date: string;
  utr: string;
  amount: string;
  mode: "UPI";
};

export type Row = string[];

/* ------------------------------------------------------------------ *
 * Vocabulary — intent based, never bank/template specific.
 * ------------------------------------------------------------------ */

const UPI_RE = /\bupi\b|upi[\s/\-:_]/i;

const CREDIT_WORDS =
  /\b(cr|crd|credit|credits|credited|credit\s*amount|credit\s*value|deposit|deposits|received|receipt|incoming|inward|in\b)\b/i;
const DEBIT_WORDS =
  /\b(dr|debit|debits|debited|debit\s*amount|debit\s*value|withdraw|withdrawal|withdrawals|withdrawn|sent|paid|payment\s*out|outgoing|outward|out\b)\b/i;
const BALANCE_WORDS = /\b(balance|bal|closing|running)\b/i;
const DATE_WORDS = /\b(date|dt)\b|date/i;
const AMOUNT_WORDS = /\b(amount|amt|value|transaction\s*amount)\b/i;
const TYPE_WORDS = /(type|cr\s*[/|]\s*dr|dr\s*[/|]\s*cr|indicator|dr\s*\/\s*cr)/i;
const NARRATION_WORDS = /(narration|description|particular|remark|details|transaction\s*detail)/i;

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

const DATE_PATTERNS: RegExp[] = [
  /\b(\d{2})[-/.](\d{2})[-/.](\d{4})\b/,
  /\b(\d{4})[-/.](\d{2})[-/.](\d{2})\b/,
  /\b(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{2,4})\b/,
  /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})\b/,
];

function pad(n: string) {
  return n.padStart(2, "0");
}

/** Returns DD/MM/YYYY or null */
export function extractDate(text: string): string | null {
  const [dmy, ymd, dMon, dmy2] = DATE_PATTERNS as [RegExp, RegExp, RegExp, RegExp];

  let m = dmy.exec(text);
  if (m) return `${m[1]}/${m[2]}/${m[3]}`;

  m = ymd.exec(text);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;

  m = dMon.exec(text);
  if (m) {
    const mon = MONTHS[(m[2] ?? "").slice(0, 3).toLowerCase()];
    if (mon) {
      let y = m[3] ?? "";
      if (y.length === 2) y = Number(y) > 70 ? `19${y}` : `20${y}`;
      return `${pad(m[1] ?? "")}/${mon}/${y}`;
    }
  }

  m = dmy2.exec(text);
  if (m) return `${pad(m[1] ?? "")}/${pad(m[2] ?? "")}/20${m[3]}`;

  return null;
}

/** Every standalone 12-digit numeric value in the row. */
export function extractUtrCandidates(text: string): string[] {
  return text.match(/(?<!\d)\d{12}(?!\d)/g) ?? [];
}

/** Best 12-digit reference for a UPI row: prefer one appearing after the UPI keyword. */
export function extractUtr(text: string): string | null {
  const all = extractUtrCandidates(text);
  if (!all.length) return null;
  const upiIdx = text.search(UPI_RE);
  if (upiIdx >= 0) {
    const after = extractUtrCandidates(text.slice(upiIdx));
    if (after.length) return after[0] ?? null;
  }
  return all[0] ?? null;
}

const MONEY_RE = /(?<![\d.])(\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?!\d)/g;

function toNumber(s: string) {
  return Number(s.replace(/,/g, ""));
}

/** Money-looking tokens in a fragment, with dates and long references removed. */
function moneyTokens(text: string): string[] {
  const cleaned = text
    .replace(/\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}/g, " ")
    .replace(/(?<!\d)\d{7,}(?!\d)/g, " ")
    .replace(/(?<!\d)\d{5,6}(?![\d.,])/g, " "); // bare 5-6 digit refs, but keep 12345.67
  return cleaned.match(MONEY_RE) ?? [];
}

function cellAmount(cell: string): number | null {
  const t = moneyTokens(cell);
  if (!t.length) return null;
  const n = toNumber(t[t.length - 1] ?? "");
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ *
 * Column classification (intelligent, position independent)
 * ------------------------------------------------------------------ */

export type ColumnMap = {
  date?: number;
  narration?: number;
  credit?: number;
  debit?: number;
  amount?: number;
  type?: number;
  balance?: number;
};

/** Classify a candidate header row. Returns null when it is not a header. */
export function detectColumns(header: Row): ColumnMap | null {
  const map: ColumnMap = {};
  let hits = 0;
  header.forEach((raw, i) => {
    const h = (raw || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!h || h.length > 40) return;
    if (BALANCE_WORDS.test(h)) {
      if (map.balance === undefined) map.balance = i;
      return;
    }
    if (DATE_WORDS.test(h) && !/update/.test(h)) {
      if (map.date === undefined) {
        map.date = i;
        hits++;
      }
      return;
    }
    if (NARRATION_WORDS.test(h)) {
      if (map.narration === undefined) map.narration = i;
      hits++;
      return;
    }
    if (TYPE_WORDS.test(h)) {
      if (map.type === undefined) map.type = i;
      hits++;
      return;
    }
    if (CREDIT_WORDS.test(h) && !DEBIT_WORDS.test(h)) {
      if (map.credit === undefined) map.credit = i;
      hits++;
      return;
    }
    if (DEBIT_WORDS.test(h) && !CREDIT_WORDS.test(h)) {
      if (map.debit === undefined) map.debit = i;
      hits++;
      return;
    }
    if (AMOUNT_WORDS.test(h)) {
      if (map.amount === undefined) map.amount = i;
      hits++;
    }
  });
  return hits >= 2 ? map : null;
}

/* ------------------------------------------------------------------ *
 * Row engine
 * ------------------------------------------------------------------ */

export type RowDiagnostic = {
  index: number;
  preview: string;
  hasDate: boolean;
  isUpi: boolean;
  references: number;
  direction: "credit" | "debit" | "unknown";
  amount: string | null;
  accepted: boolean;
  reason?: string;
};

export type ExtractDebug = {
  inputLines: number;
  transactionRows: number;
  upiRows: number;
  rowsWithReference: number;
  creditRows: number;
  accepted: number;
  columns: ColumnMap | null;
  rows: RowDiagnostic[];
};

export type ExtractResult = {
  rows: UpiCredit[];
  debug: ExtractDebug;
};

function fmtAmount(n: number) {
  return n.toFixed(2);
}

type RowValue = { index: number; value: number };

function rowValues(cells: Row, cols: ColumnMap | null): RowValue[] {
  // Unsegmented row (plain text line): treat each money token as its own slot.
  if (cells.length === 1) {
    return moneyTokens(cells[0] || "").map((t, i) => ({ index: i, value: toNumber(t) }));
  }
  const out: RowValue[] = [];
  cells.forEach((cell, i) => {
    if (cols?.date === i || cols?.narration === i) return;
    const v = cellAmount(cell || "");
    if (v !== null) out.push({ index: i, value: v });
  });
  return out;
}


type Classified = {
  direction: "credit" | "debit" | "unknown";
  amount: number | null;
  balance: number | null;
  note?: string;
};

/** Decide credit/debit and the transaction amount for a single row, in isolation. */
function classifyRow(
  cells: Row,
  text: string,
  cols: ColumnMap | null,
  prevBalance: number | null,
): Classified {
  const values = rowValues(cells, cols);

  // Balance: explicit column, otherwise the last numeric on the row.
  let balance: number | null = null;
  let balanceIdx: number | null = null;
  if (cols?.balance !== undefined) {
    const v = cellAmount(cells[cols.balance] || "");
    if (v !== null) {
      balance = v;
      balanceIdx = cols.balance;
    }
  } else if (values.length >= 2) {
    const last = values[values.length - 1] as RowValue;
    balance = last.value;
    balanceIdx = last.index;
  }

  const nonBalance = values.filter((v) => v.index !== balanceIdx && v.value > 0);

  // 1. Explicit credit / debit columns.
  if (cols?.credit !== undefined || cols?.debit !== undefined) {
    const credit = cols?.credit !== undefined ? cellAmount(cells[cols.credit] || "") : null;
    const debit = cols?.debit !== undefined ? cellAmount(cells[cols.debit] || "") : null;
    if (debit && debit > 0) return { direction: "debit", amount: debit, balance };
    if (credit && credit > 0) return { direction: "credit", amount: credit, balance };
  }

  // 2. Explicit type / indicator column or a standalone Cr/Dr token in the row.
  const typeCell = cols?.type !== undefined ? cells[cols.type] || "" : "";
  const indicator = typeCell || cells.find((c) => /^\s*(cr|dr|c|d)\.?\s*$/i.test(c || "")) || "";
  let direction: "credit" | "debit" | "unknown" = "unknown";
  if (indicator) {
    if (CREDIT_WORDS.test(indicator) && !DEBIT_WORDS.test(indicator)) direction = "credit";
    else if (DEBIT_WORDS.test(indicator)) direction = "debit";
  }

  // 3. Balance chain — the most reliable bank-independent signal.
  let chainAmount: number | null = null;
  if (balance !== null && prevBalance !== null) {
    const delta = Number((balance - prevBalance).toFixed(2));
    const match = nonBalance.find((v) => Math.abs(v.value - Math.abs(delta)) < 0.02);
    if (match && Math.abs(delta) > 0) {
      chainAmount = match.value;
      direction = delta > 0 ? "credit" : "debit";
    }
  }

  // 4. Fall back to Cr/Dr words anywhere in this row (this row only).
  if (direction === "unknown") {
    const c = CREDIT_WORDS.test(text);
    const d = DEBIT_WORDS.test(text);
    if (c && !d) direction = "credit";
    else if (d && !c) direction = "debit";
  }

  // Amount selection.
  let amount: number | null = chainAmount;
  if (amount === null && cols?.amount !== undefined) amount = cellAmount(cells[cols.amount] || "");
  if (amount === null) {
    if (nonBalance.length === 1) amount = (nonBalance[0] as RowValue).value;
    else if (nonBalance.length > 1) {
      // Positional slots (OCR/pipe rows): debit slot then credit slot.
      amount = (nonBalance[nonBalance.length - 1] as RowValue).value;
    }
  }

  return { direction, amount, balance };
}

function analyze(rowsIn: Row[]): ExtractResult {
  const diagnostics: RowDiagnostic[] = [];
  const results: UpiCredit[] = [];
  let cols: ColumnMap | null = null;
  let headerLen = 0;
  let prevBalance: number | null = null;

  let transactionRows = 0;
  let upiRows = 0;
  let rowsWithReference = 0;
  let creditRows = 0;

  rowsIn.forEach((raw, i) => {
    const cells = raw.map((c) => (c == null ? "" : String(c).replace(/\s+/g, " ").trim()));
    const text = cells.join(" ").trim();
    if (!text) return;

    const push = (d: Omit<RowDiagnostic, "index" | "preview">) =>
      diagnostics.push({ index: i, preview: text.slice(0, 160), ...d });

    // Header rows re-train the column map; they are never transactions.
    const maybeHeader = detectColumns(cells);
    if (maybeHeader && !UPI_RE.test(text) && extractDate(text) === null) {
      cols = maybeHeader;
      headerLen = cells.length;
      push({
        hasDate: false,
        isUpi: false,
        references: 0,
        direction: "unknown",
        amount: null,
        accepted: false,
        reason: "Header row — column map learned",
      });
      return;
    }

    // Column indices only apply when this row really has the header's shape;
    // text/OCR rows often collapse empty cells, so fall back to content rules.
    const rowCols = cols && cells.length === headerLen ? cols : null;

    const dateCell = rowCols?.date !== undefined ? cells[rowCols.date] || "" : "";
    const date = extractDate(dateCell) ?? extractDate(cells[0] || "") ?? extractDate(text);

    const refs = extractUtrCandidates(text);
    const isUpi = UPI_RE.test(text);

    if (!date) {
      push({
        hasDate: false,
        isUpi,
        references: refs.length,
        direction: "unknown",
        amount: null,
        accepted: false,
        reason: "No date — not a transaction row (header, footer or summary)",
      });
      return;
    }

    transactionRows++;
    const cls = classifyRow(cells, text, rowCols, prevBalance);
    if (cls.balance !== null) prevBalance = cls.balance;
    if (isUpi) upiRows++;
    if (refs.length) rowsWithReference++;
    if (cls.direction === "credit") creditRows++;

    const base = {
      hasDate: true,
      isUpi,
      references: refs.length,
      direction: cls.direction,
      amount: cls.amount === null ? null : fmtAmount(cls.amount),
    };

    if (!isUpi) {
      push({ ...base, accepted: false, reason: "No UPI keyword in narration" });
      return;
    }
    const utr = extractUtr(text);
    if (!utr) {
      push({ ...base, accepted: false, reason: "No 12-digit UPI reference on this row" });
      return;
    }
    if (cls.direction === "debit") {
      push({ ...base, accepted: false, reason: "Row classified as Debit" });
      return;
    }
    if (cls.direction === "unknown") {
      push({ ...base, accepted: false, reason: "Could not classify row as Credit or Debit" });
      return;
    }
    if (!cls.amount || cls.amount <= 0) {
      push({ ...base, accepted: false, reason: "No credit amount found (balance excluded)" });
      return;
    }

    results.push({ date, utr, amount: fmtAmount(cls.amount), mode: "UPI" });
    push({ ...base, accepted: true });
  });

  const rows = dedupe(results);
  return {
    rows,
    debug: {
      inputLines: rowsIn.length,
      transactionRows,
      upiRows,
      rowsWithReference,
      creditRows,
      accepted: rows.length,
      columns: cols,
      rows: diagnostics,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Text → rows
 * ------------------------------------------------------------------ */

/** Merge wrapped continuation lines into the row that started a transaction. */
function stitchLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\u00a0/g, " ").trimEnd();
    if (!line.trim()) continue;
    const startsTxn = extractDate(line) !== null;
    if (startsTxn || out.length === 0) out.push(line);
    else out[out.length - 1] += " " + line.trim();
  }
  return out;
}

/** Split one statement line into cells without assuming any fixed layout. */
function lineToCells(line: string): Row {
  if (line.includes("|")) return line.split("|").map((p) => p.trim());
  if (line.includes("\t")) return line.split("\t").map((p) => p.trim());
  const bySpaces = line.split(/\s{2,}/).map((p) => p.trim());
  if (bySpaces.length >= 3) return bySpaces;
  return [line.trim()];
}

export function parseTextDetailed(text: string): ExtractResult {
  return analyze(stitchLines(text.split(/\r?\n/)).map(lineToCells));
}

export function parseRowsDetailed(rows: Row[]): ExtractResult {
  return analyze(rows.map((r) => r.map((c) => (c == null ? "" : String(c)))));
}

export function parseText(text: string): UpiCredit[] {
  return parseTextDetailed(text).rows;
}

export function parseRows(rows: Row[]): UpiCredit[] {
  return parseRowsDetailed(rows).rows;
}

export function mergeResults(list: ExtractResult[]): ExtractResult {
  const rows = dedupe(list.flatMap((r) => r.rows));
  return {
    rows,
    debug: {
      inputLines: list.reduce((s, r) => s + r.debug.inputLines, 0),
      transactionRows: list.reduce((s, r) => s + r.debug.transactionRows, 0),
      upiRows: list.reduce((s, r) => s + r.debug.upiRows, 0),
      rowsWithReference: list.reduce((s, r) => s + r.debug.rowsWithReference, 0),
      creditRows: list.reduce((s, r) => s + r.debug.creditRows, 0),
      accepted: rows.length,
      columns: list.find((r) => r.debug.columns)?.debug.columns ?? null,
      rows: list.flatMap((r) => r.debug.rows),
    },
  };
}

function dedupe(list: UpiCredit[]): UpiCredit[] {
  const seen = new Set<string>();
  return list.filter((r) => {
    const k = `${r.date}|${r.utr}|${r.amount}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function toCsv(rows: UpiCredit[]): string {
  return ["Date,UTR,Amount,Mode", ...rows.map((r) => `${r.date},${r.utr},${r.amount},${r.mode}`)].join(
    "\n",
  );
}
