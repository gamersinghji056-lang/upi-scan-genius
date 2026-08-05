export type UpiCredit = {
  date: string;
  utr: string;
  amount: string;
  mode: "UPI";
};

export type Row = string[];

const UPI_RE = /\bupi\b|upi[\/\-:]/i;
const EXCLUDE_RE =
  /\b(neft|rtgs|imps|cheque|chq|cash\s*dep|cash\s*with|atm|pos\b|debit\s*card|credit\s*card|interest|charges?|reversal|opening\s*balance|closing\s*balance|available\s*balance)\b/i;

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

const DATE_PATTERNS: RegExp[] = [
  /\b(\d{2})[-/.](\d{2})[-/.](\d{4})\b/,
  /\b(\d{4})[-/.](\d{2})[-/.](\d{2})\b/,
  /\b(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{2,4})\b/,
  /\b(\d{2})[-/.](\d{2})[-/.](\d{2})\b/,
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
  if (m) return `${m[1]}/${m[2]}/20${m[3]}`;

  return null;
}


/** First standalone 12-digit numeric reference in the row. */
export function extractUtr(text: string): string | null {
  const matches = text.match(/(?<!\d)\d{12}(?!\d)/g);
  if (!matches) return null;
  // Prefer a 12-digit number appearing after the UPI keyword in the narration.
  const upiIdx = text.search(UPI_RE);
  if (upiIdx >= 0) {
    const after = text.slice(upiIdx).match(/(?<!\d)\d{12}(?!\d)/);
    if (after) return after[0];
  }
  return matches[0];
}

const MONEY_RE = /(?<![\d.])(\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?|\d+\.\d{1,2})(?!\d)/g;

function toNumber(s: string) {
  return Number(s.replace(/,/g, ""));
}

function moneyTokens(text: string): string[] {
  // Strip dates and long reference numbers so they are not read as amounts.
  const cleaned = text
    .replace(/\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}/g, " ")
    .replace(/(?<!\d)\d{10,}(?!\d)/g, " ");
  return cleaned.match(MONEY_RE) ?? [];
}

const CREDIT_RE = /\b(cr|credit|deposit|received|incoming|inward)\b/i;
const DEBIT_RE = /\b(dr|debit|withdrawal|withdrawn|paid|sent|outgoing)\b/i;

export type ColumnMap = {
  date?: number;
  credit?: number;
  debit?: number;
  amount?: number;
  type?: number;
  balance?: number;
};

export function detectColumns(header: Row): ColumnMap | null {
  const map: ColumnMap = {};
  let hits = 0;
  header.forEach((raw, i) => {
    const h = (raw || "").toLowerCase().trim();
    if (!h) return;
    if (map.date === undefined && /(txn|transaction|value|tran|book)?\s*date/.test(h)) {
      if (/value/.test(h) && map.date !== undefined) return;
      map.date = i;
      hits++;
    } else if (/credit|deposit|cr\s*amount|\bcr\b/.test(h) && !/debit/.test(h)) {
      map.credit = i;
      hits++;
    } else if (/debit|withdraw|dr\s*amount|\bdr\b/.test(h)) {
      map.debit = i;
      hits++;
    } else if (/balance/.test(h)) {
      map.balance = i;
    } else if (/amount|amt/.test(h)) {
      map.amount = i;
      hits++;
    } else if (/type|cr\s*\/\s*dr|dr\s*\/\s*cr|indicator/.test(h)) {
      map.type = i;
      hits++;
    }
  });
  return hits >= 2 ? map : null;
}

function fmtAmount(n: number) {
  return n.toFixed(2);
}

function parseTabularRow(cells: Row, cols: ColumnMap): UpiCredit | null {
  const line = cells.join(" ");
  if (!UPI_RE.test(line)) return null;

  const utr = extractUtr(line);
  if (!utr) return null;

  const dateCell = cols.date !== undefined ? cells[cols.date] : "";
  const date = extractDate(dateCell || "") ?? extractDate(line);
  if (!date) return null;

  let amount: number | null = null;

  if (cols.credit !== undefined) {
    const v = moneyTokens(cells[cols.credit] || "");
    if (v.length) amount = toNumber(v[v.length - 1] ?? "0");
    if (amount === null || amount === 0) return null;
  } else {
    const typeVal = cols.type !== undefined ? (cells[cols.type] || "") : "";
    const isCredit = typeVal
      ? CREDIT_RE.test(typeVal) && !DEBIT_RE.test(typeVal)
      : CREDIT_RE.test(line) && !DEBIT_RE.test(line);
    if (!isCredit) return null;
    if (cols.debit !== undefined) {
      const d = moneyTokens(cells[cols.debit] || "");
      if (d.length && toNumber(d[d.length - 1] ?? "0") > 0) return null;
    }
    const src = cols.amount !== undefined ? cells[cols.amount] || "" : line;
    const v = moneyTokens(src);
    if (!v.length) return null;
    amount = toNumber((cols.amount !== undefined ? v[v.length - 1] : (v[v.length - 2] ?? v[0])) ?? "0");
  }

  if (!amount || amount <= 0) return null;
  return { date, utr, amount: fmtAmount(amount), mode: "UPI" };
}

function parseTextRow(line: string): UpiCredit | null {
  if (!UPI_RE.test(line)) return null;
  if (EXCLUDE_RE.test(line) && !/upi/i.test(line.replace(EXCLUDE_RE, ""))) return null;

  const hasCredit = CREDIT_RE.test(line);
  const hasDebit = DEBIT_RE.test(line);
  if (!hasCredit || hasDebit) return null;

  const utr = extractUtr(line);
  if (!utr) return null;

  const date = extractDate(line);
  if (!date) return null;

  const tokens = moneyTokens(line);
  if (!tokens.length) return null;
  // Last money token on a statement line is typically the running balance.
  const amountToken = tokens.length >= 2 ? tokens[tokens.length - 2] : tokens[0];
  const amount = toNumber(amountToken ?? "0");
  if (!amount || amount <= 0) return null;

  return { date, utr, amount: fmtAmount(amount), mode: "UPI" };
}

/** Merge wrapped continuation lines into the line that started a transaction. */
function stitchLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const startsTxn = extractDate(line) !== null;
    if (startsTxn || out.length === 0) out.push(line);
    else out[out.length - 1] += " " + line;
  }
  return out;
}

/** Pipe-delimited OCR line: date | narration | ref | debit | credit | balance */
function parsePipeRow(line: string): UpiCredit | null {
  const parts = line.split("|").map((p) => p.trim());
  if (parts.length < 5) return null;
  const joined = parts.join(" ");
  if (!UPI_RE.test(joined)) return null;

  const utr = extractUtr(joined);
  if (!utr) return null;
  const date = extractDate(parts[0] || "") ?? extractDate(joined);
  if (!date) return null;

  const debit = moneyTokens(parts[3] || "");
  const credit = moneyTokens(parts[4] || "");
  if (debit.length && toNumber(debit[debit.length - 1] ?? "0") > 0) return null;
  if (!credit.length) return null;
  const amount = toNumber(credit[credit.length - 1] ?? "0");
  if (!amount || amount <= 0) return null;

  return { date, utr, amount: fmtAmount(amount), mode: "UPI" };
}

export function parseText(text: string): UpiCredit[] {
  const results: UpiCredit[] = [];
  for (const line of stitchLines(text.split(/\r?\n/))) {
    const r = (line.includes("|") ? parsePipeRow(line) : null) ?? parseTextRow(line);
    if (r) results.push(r);
  }
  return dedupe(results);
}


export function parseRows(rows: Row[]): UpiCredit[] {
  const cleaned = rows.map((r) => r.map((c) => (c == null ? "" : String(c).trim())));
  let cols: ColumnMap | null = null;
  const results: UpiCredit[] = [];

  for (const cells of cleaned) {
    if (!cells.some((c) => c)) continue;
    const maybe = detectColumns(cells);
    if (maybe && !UPI_RE.test(cells.join(" "))) {
      cols = maybe;
      continue;
    }
    const r = cols ? parseTabularRow(cells, cols) : parseTextRow(cells.join(" "));
    if (r) results.push(r);
  }
  return dedupe(results);
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
