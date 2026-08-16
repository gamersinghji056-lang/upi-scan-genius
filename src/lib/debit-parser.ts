/* ------------------------------------------------------------------ *
 * Debit extraction engine — separate from the UPI credit parser.
 * Supports UPI, IMPS, NEFT and RTGS debits, bank independent.
 *
 * IMPORTANT:
 * - Existing UPI credit parser is untouched.
 * - Debit reference extraction is intentionally flexible.
 * - References are selected from the SAME transaction row only.
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
  { mode: "UPI", re: /\bupi\b|upi[\s/\-:_]|\bbhim\b|\bmpay\s*\/\s*upi\b/i },
];

const EXCLUDE_RE =
  /\b(atm|cash\s*wdl|cash\s*withdrawal|cheque|chq|clg|card\s*payment|pos\s|debit\s*card|credit\s*card|charges?|gst|interest|emi|ecs\b|ach\b)\b/i;

const DEBIT_WORDS =
  /\b(dr|debit|debits|debited|withdraw|withdrawal|withdrawals|withdrawn|sent|paid|payment|payments|transfer\s*out|outgoing|outward|out)\b/i;

const CREDIT_WORDS =
  /\b(cr|credit|credits|credited|deposit|deposits|received|incoming|inward|in)\b/i;

const BALANCE_WORDS = /\b(balance|bal|closing|running|available)\b/i;

const EXPLICIT_REF_RE =
  /\b(utr|rrn|upi\s*ref(?:erence)?|imps\s*ref(?:erence)?|neft\s*ref(?:erence)?|rtgs\s*ref(?:erence)?|ref(?:erence)?(?:\s*(?:no|num|number))?|txn\s*ref(?:erence)?|transaction\s*ref(?:erence)?|txn\s*id|transaction\s*id|trn)\b/i;

const BAD_REF_CONTEXT =
  /(a\/?c|acct|account|ben(?:eficiary)?|mobile|phone|ifsc|vpa|balance|bal\b|amount|amt|date|time)/i;

/* ------------------------------ money ------------------------------ */

const MONEY_RE =
  /(?<![\d.])(\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?!\d)/g;

function toNumber(s: string) {
  return Number(s.replace(/,/g, ""));
}

function moneyTokens(text: string): string[] {
  const cleaned = text
    .replace(/\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}/g, " ")
    .replace(/[A-Za-z]+[\d.,]+[A-Za-z]*|[\d.,]+[A-Za-z]+/g, " ")
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
  for (const { mode, re } of MODE_PATTERNS) {
    if (re.test(text)) return mode;
  }
  return null;
}

/* -------------------------- reference engine ----------------------- */

type CandidateSource =
  | "explicit"
  | "mode-pattern"
  | "token"
  | "numeric"
  | "bank-prefixed";

type Candidate = {
  value: string;
  index: number;
  source: CandidateSource;
  score: number;
};

/**
 * Normalizes a reference without destroying meaningful alphanumeric content.
 * We strip surrounding punctuation but keep internal -, _, / because some
 * bank-generated references contain separators.
 */
function cleanRef(value: string): string {
  return value
    .trim()
    .replace(/^[\s:;,.()[\]{}<>|]+/, "")
    .replace(/[\s:;,.()[\]{}<>|]+$/, "");
}

function looksLikeIfsc(v: string): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/i.test(v);
}

function looksLikeDate(v: string): boolean {
  return /^\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(v);
}

function looksLikeMoney(v: string): boolean {
  return /^\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?$/.test(v) ||
    /^\d+\.\d{1,2}$/.test(v);
}

function looksLikeMobile(v: string): boolean {
  return /^[6-9]\d{9}$/.test(v);
}

function looksLikePureAccountNumber(v: string): boolean {
  return /^\d{14,22}$/.test(v);
}

function hasEnoughReferenceSignal(v: string): boolean {
  const compact = v.replace(/[-_/]/g, "");
  return compact.length >= 8 && compact.length <= 40 && /\d/.test(compact);
}

/**
 * Extract values appearing immediately after explicit labels such as:
 * UTR: XXXXX
 * RRN 123456789012
 * Ref No - ABC123...
 */
function explicitReferenceCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];

  const re =
    /\b(UTR|RRN|UPI\s*REF(?:ERENCE)?|IMPS\s*REF(?:ERENCE)?|NEFT\s*REF(?:ERENCE)?|RTGS\s*REF(?:ERENCE)?|REF(?:ERENCE)?(?:\s*(?:NO|NUM|NUMBER))?|TXN\s*REF(?:ERENCE)?|TRANSACTION\s*REF(?:ERENCE)?|TXN\s*ID|TRANSACTION\s*ID|TRN)\b[\s:#=\-\/]*([A-Z0-9][A-Z0-9_\/\-]{6,45})/gi;

  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = cleanRef(m[2] ?? "");
    if (!value || !hasEnoughReferenceSignal(value)) continue;

    let score = 150;
    const label = (m[1] ?? "").toUpperCase();
    if (label === "UTR") score += 60;
    else if (label === "RRN") score += 50;
    else if (/UPI|IMPS|NEFT|RTGS/.test(label)) score += 40;
    else if (/REF/.test(label)) score += 25;
    else if (/ID|TRN/.test(label)) score += 15;

    out.push({
      value,
      index: m.index + (m[0]?.lastIndexOf(m[2] ?? "") ?? 0),
      source: "explicit",
      score,
    });
  }

  return out;
}

/**
 * Extract mode-specific references from common bank narration shapes.
 * Examples:
 * UPI/123456789012/...
 * MPAY/UPI/TRTR/870538678930/...
 * IMPS/P2A/607813136431/...
 * NEFT-BARBL26078306964-...
 * RTGS-BARBR52026031900028575-...
 */
function modeSpecificCandidates(text: string, mode: DebitMode): Candidate[] {
  const out: Candidate[] = [];

  const pushMatch = (re: RegExp, baseScore: number) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1] ?? "";
      const value = cleanRef(raw);
      if (!value || !hasEnoughReferenceSignal(value)) continue;
      out.push({
        value,
        index: m.index + (m[0]?.lastIndexOf(raw) ?? 0),
        source: "mode-pattern",
        score: baseScore,
      });
    }
  };

  if (mode === "UPI") {
    pushMatch(/\bUPI[\s\/:_-]+(?:CR[\s\/:_-]+|DR[\s\/:_-]+|P2A[\s\/:_-]+|P2M[\s\/:_-]+|PAY[\s\/:_-]+|PAYMENT[\s\/:_-]+|COLLECT[\s\/:_-]+|TRTR[\s\/:_-]+)*([0-9]{12})(?!\d)/gi, 130);
    pushMatch(/\bMPAY[\s\/:_-]+UPI[\s\/:_-]+(?:TRTR[\s\/:_-]+)?([0-9]{12})(?!\d)/gi, 145);
    pushMatch(/\bBHIM[\s\/:_-]+UPI[\s\/:_-]+([0-9]{12})(?!\d)/gi, 135);
  }

  if (mode === "IMPS") {
    pushMatch(/\bIMPS[\s\/:_-]+(?:P2A[\s\/:_-]+|P2P[\s\/:_-]+)?([0-9]{10,18})(?!\d)/gi, 140);
  }

  if (mode === "NEFT") {
    pushMatch(/\b(?:IBNEFT|ENEFT|NEFT)[\s\/:_-]+([A-Z0-9][A-Z0-9_-]{8,35})/gi, 145);
    pushMatch(/\b([A-Z]{2,8}[A-Z]?\d{8,30})\b/gi, 85);
  }

  if (mode === "RTGS") {
    pushMatch(/\bRTGS[\s\/:_-]+([A-Z0-9][A-Z0-9_-]{8,40})/gi, 150);
    pushMatch(/\b([A-Z]{2,8}R?\d{10,32})\b/gi, 90);
  }

  return out;
}

/**
 * Generic candidate extraction. This is deliberately more permissive than
 * the old 8-32 continuous alphanumeric regex because bank references can
 * contain separators or can be split by PDF text extraction.
 */
function genericCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];

  // Numeric references — useful for UPI/IMPS and some bank-specific formats.
  const numeric = /(?<!\d)(\d{8,24})(?!\d)/g;
  let n: RegExpExecArray | null;
  while ((n = numeric.exec(text)) !== null) {
    const value = n[1] ?? "";
    out.push({
      value,
      index: n.index,
      source: "numeric",
      score: /^\d{12}$/.test(value) ? 85 : 35,
    });
  }

  // Alphanumeric references, allowing -, _, / internally.
  const token =
    /(?<![A-Za-z0-9])([A-Za-z0-9][A-Za-z0-9_\/\-]{7,39})(?![A-Za-z0-9])/g;

  let m: RegExpExecArray | null;
  while ((m = token.exec(text)) !== null) {
    const value = cleanRef(m[1] ?? "");
    if (!value || !hasEnoughReferenceSignal(value)) continue;

    let score = 20;
    if (/^[A-Za-z]{2,8}[A-Za-z]?\d{6,}$/i.test(value.replace(/[-_/]/g, ""))) {
      score += 45;
    }

    out.push({
      value,
      index: m.index,
      source: /^[A-Za-z]/.test(value) ? "bank-prefixed" : "token",
      score,
    });
  }

  return out;
}

function uniqueCandidates(list: Candidate[]): Candidate[] {
  const seen = new Map<string, Candidate>();

  for (const candidate of list) {
    const key = candidate.value.toUpperCase();
    const current = seen.get(key);
    if (!current || candidate.score > current.score) {
      seen.set(key, candidate);
    }
  }

  return [...seen.values()];
}

function scoreCandidate(
  text: string,
  candidate: Candidate,
  mode: DebitMode,
): number {
  const value = candidate.value;
  let score = candidate.score;

  const before = text.slice(Math.max(0, candidate.index - 45), candidate.index);
  const after = text.slice(
    candidate.index + value.length,
    candidate.index + value.length + 30,
  );
  const nearby = `${before} ${after}`;

  if (EXPLICIT_REF_RE.test(before)) score += 75;
  if (BAD_REF_CONTEXT.test(before)) score -= 130;

  if (/^\d{12}$/.test(value)) {
    if (mode === "UPI" || mode === "IMPS") score += 65;
    else score += 15;
  }

  const compact = value.replace(/[-_/]/g, "");
  if (/^[A-Za-z]{2,10}\d{6,}$/i.test(compact)) {
    if (mode === "NEFT" || mode === "RTGS") score += 70;
    else score += 20;
  }

  if (looksLikeIfsc(value)) score -= 300;
  if (looksLikeDate(value)) score -= 300;
  if (looksLikeMoney(value)) score -= 250;
  if (looksLikeMobile(value)) score -= 160;
  if (looksLikePureAccountNumber(value)) score -= 80;

  if (/\b(?:account|acct|a\/c|beneficiary|mobile|phone|ifsc|vpa)\b/i.test(nearby)) {
    score -= 50;
  }

  const modeRe = MODE_PATTERNS.find((p) => p.mode === mode)?.re;
  const modeIdx = modeRe ? text.search(modeRe) : -1;
  if (modeIdx >= 0) {
    const distance = Math.abs(candidate.index - modeIdx);
    score += Math.max(0, 70 - Math.floor(distance / 4));
  }

  // References following slash-separated mode tokens deserve extra trust.
  const left = text.slice(Math.max(0, candidate.index - 25), candidate.index);
  if (mode === "UPI" && /(?:UPI|TRTR|P2A|P2M)[\s\/:_-]*$/i.test(left)) score += 55;
  if (mode === "IMPS" && /(?:IMPS|P2A|P2P)[\s\/:_-]*$/i.test(left)) score += 55;
  if (mode === "NEFT" && /(?:NEFT|IBNEFT|ENEFT)[\s\/:_-]*$/i.test(left)) score += 60;
  if (mode === "RTGS" && /RTGS[\s\/:_-]*$/i.test(left)) score += 60;

  return score;
}

/**
 * Public reference extractor.
 *
 * Priority:
 * 1. Explicit UTR/RRN/Ref labels
 * 2. Mode-specific narration patterns
 * 3. Flexible same-row candidate scoring
 *
 * We do NOT require one universal length or one universal bank prefix.
 */
export function extractDebitRef(text: string, mode: DebitMode): string | null {
  const normalized = text
    .replace(/\u00a0/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/\s*([\/:_-])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  const list = uniqueCandidates([
    ...explicitReferenceCandidates(normalized),
    ...modeSpecificCandidates(normalized, mode),
    ...genericCandidates(normalized),
  ]);

  if (!list.length) return null;

  const scored = list
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(normalized, candidate, mode),
    }))
    .filter(({ candidate }) => {
      const v = candidate.value;
      if (!hasEnoughReferenceSignal(v)) return false;
      if (looksLikeIfsc(v)) return false;
      if (looksLikeDate(v)) return false;
      if (looksLikeMoney(v)) return false;
      return true;
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.candidate.index - b.candidate.index,
    );

  const best = scored[0];

  // Keep a small positive threshold to avoid random account/mobile numbers,
  // but do not use the previous overly-strict rejection behaviour.
  if (!best || best.score < 20) return null;

  return best.candidate.value;
}

/* ------------------------------ engine ------------------------------ */

function rowValues(
  cells: Row,
  cols: ColumnMap | null,
): Array<{ index: number; value: number }> {
  if (cells.length === 1) {
    return moneyTokens(cells[0] || "").map((t, i) => ({
      index: i,
      value: toNumber(t),
    }));
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
    const cells = raw.map((c) =>
      c == null ? "" : String(c).replace(/\s+/g, " ").trim(),
    );
    const text = cells.join(" ").trim();

    if (!text) continue;

    if (
      /\b(opening\s*balance|balance\s*b\/?f|brought\s*forward|b\/f)\b/i.test(
        text,
      )
    ) {
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

    const dateCell =
      rowCols?.date !== undefined ? cells[rowCols.date] || "" : "";

    const date =
      extractDate(dateCell) ??
      extractDate(cells[0] || "") ??
      extractDate(text);

    if (!date) continue;

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

    const nonBalance = values.filter(
      (v) => v.index !== balanceIdx && v.value > 0,
    );

    const delta =
      balance !== null && prevBalance !== null
        ? Number((balance - prevBalance).toFixed(2))
        : null;

    const prev = prevBalance;
    if (balance !== null) prevBalance = balance;

    if (EXCLUDE_RE.test(text)) continue;

    const mode = detectMode(text);
    if (!mode) continue;

    let isDebit = false;
    let amount: number | null = null;

    const debitCell =
      rowCols?.debit !== undefined
        ? cellAmount(cells[rowCols.debit] || "")
        : null;

    const creditCell =
      rowCols?.credit !== undefined
        ? cellAmount(cells[rowCols.credit] || "")
        : null;

    if (debitCell && debitCell > 0) {
      isDebit = true;
      amount = debitCell;
    } else if (creditCell && creditCell > 0) {
      continue;
    }

    const typeCell =
      rowCols?.type !== undefined ? cells[rowCols.type] || "" : "";

    const indicator =
      typeCell ||
      cells.find((c) => /^\s*(cr|dr|c|d)\.?\s*$/i.test(c || "")) ||
      "";

    if (!isDebit && indicator) {
      if (DEBIT_WORDS.test(indicator) && !CREDIT_WORDS.test(indicator)) {
        isDebit = true;
      } else if (CREDIT_WORDS.test(indicator)) {
        continue;
      }
    }

    if (delta !== null && Math.abs(delta) > 0) {
      const match = nonBalance.find(
        (v) => Math.abs(v.value - Math.abs(delta)) < 0.02,
      );

      if (match) {
        if (delta > 0) continue;
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

    if (
      !isDebit &&
      delta === null &&
      nonBalance.length === 1 &&
      !CREDIT_WORDS.test(text)
    ) {
      isDebit = true;
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

    if (
      prev !== null &&
      balance !== null &&
      Math.abs(amount - balance) < 0.001 &&
      nonBalance.length === 0
    ) {
      continue;
    }

    // Search across ALL cells belonging to the SAME row.
    const utr = extractDebitRef(text, mode);
    if (!utr) continue;

    results.push({
      date,
      utr,
      amount: fmtAmount(amount),
      mode,
    });
  }

  return { rows: dedupeDebits(results) };
}

/* ------------------------------ inputs ------------------------------ */

/**
 * Some PDF/text statements wrap a single transaction across multiple visual
 * lines. If a line does not start a new dated transaction, append it to the
 * previous transaction row.
 */
function stitchLines(lines: string[]): string[] {
  const out: string[] = [];

  for (const raw of lines) {
    const line = raw.replace(/\u00a0/g, " ").trimEnd();
    if (!line.trim()) continue;

    if (extractDate(line) !== null || out.length === 0) {
      out.push(line);
    } else {
      out[out.length - 1] += " " + line.trim();
    }
  }

  return out;
}

function lineToCells(line: string): Row {
  if (line.includes("|")) {
    return line.split("|").map((p) => p.trim());
  }

  if (line.includes("\t")) {
    return line.split("\t").map((p) => p.trim());
  }

  const bySpaces = line.split(/\s{2,}/).map((p) => p.trim());

  if (bySpaces.length >= 3) return bySpaces;

  return [line.trim()];
}

export function parseDebitsFromText(text: string): DebitResult {
  return analyzeDebits(
    stitchLines(text.split(/\r?\n/)).map(lineToCells),
  );
}

export function parseDebitsFromRows(rows: Row[]): DebitResult {
  return analyzeDebits(
    rows.map((r) =>
      r.map((c) => (c == null ? "" : String(c))),
    ),
  );
}

export function mergeDebitResults(list: DebitResult[]): DebitResult {
  return {
    rows: dedupeDebits(list.flatMap((r) => r.rows)),
  };
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

export type ModeBreakdown = {
  mode: DebitMode;
  volume: number;
  count: number;
};

export function debitBreakdown(rows: DebitTxn[]): ModeBreakdown[] {
  const modes: DebitMode[] = ["UPI", "IMPS", "NEFT", "RTGS"];

  return modes.map((mode) => {
    const list = rows.filter((r) => r.mode === mode);

    return {
      mode,
      volume: list.reduce(
        (sum, row) => sum + Number(row.amount),
        0,
      ),
      count: list.length,
    };
  });
}

export function toDebitCsv(rows: DebitTxn[]): string {
  return [
    "Date,UTR,Amount,Mode",
    ...rows.map(
      (r) => `${r.date},${r.utr},${r.amount},${r.mode}`,
    ),
  ].join("\n");
}

export function timestampName(prefix: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");

  return `${prefix}_${d.getFullYear()}${p(
    d.getMonth() + 1,
  )}${p(d.getDate())}_${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}.csv`;
}
