/* ------------------------------------------------------------------ *
 * Debit extraction engine — separate from the working UPI credit parser.
 *
 * Supports Debit:
 *   UPI + IMPS + NEFT + RTGS
 *
 * Design goals:
 * - Do NOT touch credit logic.
 * - Transaction direction is decided independently from reference extraction.
 * - A valid debit must NOT disappear only because a UTR/reference is absent.
 * - Search reference only inside the SAME transaction row.
 * - Support real-world Indian bank narration aliases seen in statement files.
 * ------------------------------------------------------------------ */

import { detectColumns, extractDate, type ColumnMap, type Row } from "./upi-parser";

export type DebitMode = "UPI" | "IMPS" | "NEFT" | "RTGS";

export type DebitTxn = {
  date: string;
  utr: string; // "N/A" when statement does not expose a usable reference
  amount: string;
  mode: DebitMode;
};

export type DebitResult = {
  rows: DebitTxn[];
};

/* ---------------------------- vocabulary --------------------------- */

const MODE_PATTERNS: Array<{ mode: DebitMode; re: RegExp }> = [
  {
    mode: "RTGS",
    re: /\b(rtgs|ibrtgs|ertgs)\b|(?:^|[\s/_:-])(rtgs|ibrtgs|ertgs)(?:$|[\s/_:-])/i,
  },
  {
    mode: "NEFT",
    re: /\b(neft|ibneft|eneft)\b|(?:^|[\s/_:-])(neft|ibneft|eneft)(?:$|[\s/_:-])/i,
  },
  {
    mode: "IMPS",
    re:
      /\bimps\b|imps[\s/_:-]|(?:^|[\s/_:-])ps[\s/_:-]*p2a(?:$|[\s/_:-])|(?:^|[\s/_:-])psp2a(?:$|[\s/_:-])|(?:^|[\s/_:-])impsp2a(?:$|[\s/_:-])|(?:^|[\s/_:-])p2a(?:$|[\s/_:-])/i,
  },
  {
    mode: "UPI",
    re:
      /\bupi\b|upi[\s/_:-]|\bbhim\b|\bmpay[\s/_:-]*upi\b|\bupi[\s/_:-]*rrn\b|\btrtr\b/i,
  },
];

const EXCLUDE_RE =
  /\b(atm|cash\s*wdl|cash\s*withdrawal|cheque|chq|clg|card\s*payment|pos\s|debit\s*card|credit\s*card|charges?|gst|interest|emi|ecs\b|ach\b|self\b)\b/i;

const DEBIT_WORDS =
  /\b(dr|debit|debits|debited|withdraw|withdrawal|withdrawals|withdrawn|sent|paid|payment|payments|transfer\s*out|outgoing|outward|out)\b/i;

const CREDIT_WORDS =
  /\b(cr|credit|credits|credited|deposit|deposits|received|incoming|inward|in)\b/i;

const BALANCE_WORDS = /\b(balance|bal|closing|running|available)\b/i;

const EXPLICIT_REF_RE =
  /\b(utr|xutr|rrn|upi\s*ref(?:erence)?|imps\s*ref(?:erence)?|neft\s*ref(?:erence)?|rtgs\s*ref(?:erence)?|ref(?:erence)?(?:\s*(?:no|num|number))?|txn\s*ref(?:erence)?|transaction\s*ref(?:erence)?|txn\s*id|transaction\s*id|trn|inst(?:rument)?\s*no)\b/i;

const BAD_REF_CONTEXT =
  /(a\/?c|acct|account|ben(?:eficiary)?|mobile|phone|ifsc|vpa|balance|bal\b|amount|amt|date|time|customer|cif)/i;

/* ------------------------------ money ------------------------------ */

const MONEY_RE =
  /(?<![\d.])(-?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)(?!\d)/g;

function toNumber(s: string) {
  return Number(s.replace(/,/g, ""));
}

function moneyTokens(text: string): string[] {
  const cleaned = text
    .replace(/\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}/g, " ")
    .replace(/[A-Za-z]+[\d.,]+[A-Za-z]*|[\d.,]+[A-Za-z]+/g, " ")
    .replace(/(?<!\d)\d{7,}(?!\d)/g, " ");

  return cleaned.match(MONEY_RE) ?? [];
}

function cellAmount(cell: string): number | null {
  const t = moneyTokens(cell);
  if (!t.length) return null;

  // Prefer the first transaction-looking numeric in an isolated table cell.
  const n = toNumber(t[0] ?? "");
  return Number.isFinite(n) ? n : null;
}

function fmtAmount(n: number) {
  return Math.abs(n).toFixed(2);
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
  | "dedicated-column"
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

function cleanRef(value: string): string {
  return value
    .trim()
    .replace(/^[\s:;,.()[\]{}<>|]+/, "")
    .replace(/[\s:;,.()[\]{}<>|]+$/, "")
    .replace(/^[-_/]+/, "")
    .replace(/[-_/]+$/, "");
}

function looksLikeIfsc(v: string): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/i.test(v);
}

function looksLikeDate(v: string): boolean {
  return /^\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(v);
}

function looksLikeMoney(v: string): boolean {
  return /^-?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?$/.test(v) ||
    /^-?\d+\.\d{1,2}$/.test(v);
}

function looksLikeMobile(v: string): boolean {
  return /^[6-9]\d{9}$/.test(v);
}

function looksLikeAccountNumber(v: string): boolean {
  return /^\d{14,22}$/.test(v);
}

function hasEnoughReferenceSignal(v: string): boolean {
  const compact = v.replace(/[-_/]/g, "");
  return compact.length >= 8 && compact.length <= 48 && /\d/.test(compact);
}

function explicitReferenceCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];

  const re =
    /\b(UTR|XUTR|RRN|UPI\s*REF(?:ERENCE)?|IMPS\s*REF(?:ERENCE)?|NEFT\s*REF(?:ERENCE)?|RTGS\s*REF(?:ERENCE)?|REF(?:ERENCE)?(?:\s*(?:NO|NUM|NUMBER))?|TXN\s*REF(?:ERENCE)?|TRANSACTION\s*REF(?:ERENCE)?|TXN\s*ID|TRANSACTION\s*ID|TRN|INST(?:RUMENT)?\s*NO)\b[\s:#=\-\/]*([A-Z0-9][A-Z0-9_\/\-]{6,47})/gi;

  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = cleanRef(m[2] ?? "");
    if (!value || !hasEnoughReferenceSignal(value)) continue;

    let score = 170;
    const label = (m[1] ?? "").toUpperCase();

    if (label === "UTR" || label === "XUTR") score += 70;
    else if (label === "RRN") score += 60;
    else if (/UPI|IMPS|NEFT|RTGS/.test(label)) score += 50;
    else if (/REF/.test(label)) score += 30;
    else if (/ID|TRN|INST/.test(label)) score += 20;

    out.push({
      value,
      index: m.index + (m[0]?.lastIndexOf(m[2] ?? "") ?? 0),
      source: "explicit",
      score,
    });
  }

  return out;
}

function modeSpecificCandidates(text: string, mode: DebitMode): Candidate[] {
  const out: Candidate[] = [];

  const push = (re: RegExp, baseScore: number) => {
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
    push(/\bUPI[\s/_:-]+RRN[\s/_:-]*([0-9]{12})(?!\d)/gi, 180);
    push(/\bUPI[\s/_:-]+(?:CR[\s/_:-]+|DR[\s/_:-]+)?([0-9]{12})(?!\d)/gi, 165);
    push(/\bMPAY[\s/_:-]+UPI[\s/_:-]+(?:TRTR[\s/_:-]+)?([0-9]{12})(?!\d)/gi, 190);
    push(/\bTRTR[\s/_:-]+([0-9]{12})(?!\d)/gi, 175);
    push(/\bBHIM[\s/_:-]+UPI[\s/_:-]+([0-9]{12})(?!\d)/gi, 165);
  }

  if (mode === "IMPS") {
    push(/\bIMPS[\s/_:-]+(?:P2A[\s/_:-]+|P2P[\s/_:-]+)?([0-9]{10,18})(?!\d)/gi, 185);
    push(/\bPS[\s/_:-]*P2A[\s/_:-]+([0-9]{10,18})(?!\d)/gi, 180);
    push(/\bPSP2A([0-9]{10,18})(?!\d)/gi, 180);
    push(/\bIMPSP2A([0-9]{10,18})(?!\d)/gi, 180);
  }

  if (mode === "NEFT") {
    // NEFT_OUT:PUNBN62025121456687398/...
    push(/\bNEFT[\s_/-]*OUT[\s:/_-]+([A-Z0-9][A-Z0-9_-]{8,40})/gi, 200);

    // NEFT-BARBL26078306964-...
    push(/\b(?:IBNEFT|ENEFT|NEFT)[\s:/_-]+([A-Z0-9][A-Z0-9_-]{8,40})/gi, 185);

    // /XUTR/AXNH261850049792
    push(/\bXUTR[\s:/_-]+([A-Z0-9][A-Z0-9_-]{8,40})/gi, 210);

    // Generic Indian bank-prefixed NEFT UTR.
    push(/\b([A-Z]{3,8}[A-Z]?\d{8,30})\b/gi, 115);
  }

  if (mode === "RTGS") {
    // RTGS-BARBR52026031900028575-...
    push(/\b(?:IBRTGS|ERTGS|RTGS)[\s:/_-]+([A-Z0-9][A-Z0-9_-]{8,44})/gi, 195);

    // MAHBR52026061124182338
    push(/\b([A-Z]{3,8}R\d{10,32})\b/gi, 150);
    push(/\b([A-Z]{4,8}\d{10,32})\b/gi, 125);
  }

  return out;
}

function genericCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];

  const numeric = /(?<!\d)(\d{8,24})(?!\d)/g;
  let n: RegExpExecArray | null;

  while ((n = numeric.exec(text)) !== null) {
    const value = n[1] ?? "";
    out.push({
      value,
      index: n.index,
      source: "numeric",
      score: /^\d{12}$/.test(value) ? 90 : 35,
    });
  }

  const token =
    /(?<![A-Za-z0-9])([A-Za-z0-9][A-Za-z0-9_\/\-]{7,47})(?![A-Za-z0-9])/g;

  let m: RegExpExecArray | null;

  while ((m = token.exec(text)) !== null) {
    const value = cleanRef(m[1] ?? "");
    if (!value || !hasEnoughReferenceSignal(value)) continue;

    let score = 20;

    const compact = value.replace(/[-_/]/g, "");
    if (/^[A-Za-z]{2,10}\d{6,}$/i.test(compact)) score += 55;

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

  const before = text.slice(Math.max(0, candidate.index - 50), candidate.index);
  const after = text.slice(
    candidate.index + value.length,
    candidate.index + value.length + 35,
  );
  const nearby = `${before} ${after}`;

  if (EXPLICIT_REF_RE.test(before)) score += 90;
  if (BAD_REF_CONTEXT.test(before)) score -= 140;

  if (/^\d{12}$/.test(value)) {
    if (mode === "UPI" || mode === "IMPS") score += 80;
    else score += 15;
  }

  const compact = value.replace(/[-_/]/g, "");

  if (/^[A-Za-z]{2,10}\d{6,}$/i.test(compact)) {
    if (mode === "NEFT" || mode === "RTGS") score += 80;
    else score += 20;
  }

  if (looksLikeIfsc(value)) score -= 350;
  if (looksLikeDate(value)) score -= 350;
  if (looksLikeMoney(value)) score -= 300;
  if (looksLikeMobile(value)) score -= 200;
  if (looksLikeAccountNumber(value)) score -= 100;

  if (
    /\b(?:account|acct|a\/c|beneficiary|mobile|phone|ifsc|vpa|customer|cif)\b/i.test(
      nearby,
    )
  ) {
    score -= 65;
  }

  const modeRe = MODE_PATTERNS.find((p) => p.mode === mode)?.re;
  const modeIdx = modeRe ? text.search(modeRe) : -1;

  if (modeIdx >= 0) {
    const distance = Math.abs(candidate.index - modeIdx);
    score += Math.max(0, 85 - Math.floor(distance / 4));
  }

  const left = text.slice(Math.max(0, candidate.index - 30), candidate.index);

  if (mode === "UPI" && /(?:UPI|RRN|TRTR|P2A|P2M)[\s/_:-]*$/i.test(left)) {
    score += 65;
  }

  if (mode === "IMPS" && /(?:IMPS|PS|P2A|P2P|PSP2A|IMPSP2A)[\s/_:-]*$/i.test(left)) {
    score += 65;
  }

  if (mode === "NEFT" && /(?:NEFT|IBNEFT|ENEFT|XUTR|OUT)[\s/_:-]*$/i.test(left)) {
    score += 70;
  }

  if (mode === "RTGS" && /(?:RTGS|IBRTGS|ERTGS)[\s/_:-]*$/i.test(left)) {
    score += 70;
  }

  return score;
}

function extractRefFromDedicatedCells(
  cells: Row,
  cols: ColumnMap | null,
): string | null {
  if (!cols) return null;

  // The existing ColumnMap does not expose a dedicated ref index, so inspect
  // non-date/non-amount cells that look like an isolated bank reference.
  for (let i = 0; i < cells.length; i++) {
    if (
      i === cols.date ||
      i === cols.credit ||
      i === cols.debit ||
      i === cols.amount ||
      i === cols.balance ||
      i === cols.type
    ) {
      continue;
    }

    const cell = cleanRef(cells[i] || "");
    if (!cell || /\s/.test(cell)) continue;
    if (!hasEnoughReferenceSignal(cell)) continue;
    if (looksLikeIfsc(cell) || looksLikeDate(cell) || looksLikeMoney(cell)) continue;

    if (
      /^\d{12}$/.test(cell) ||
      /^[A-Za-z]{3,10}\d{8,30}$/i.test(cell.replace(/[-_/]/g, ""))
    ) {
      return cell;
    }
  }

  return null;
}

export function extractDebitRef(
  text: string,
  mode: DebitMode,
  cells?: Row,
  cols?: ColumnMap | null,
): string | null {
  const dedicated = cells ? extractRefFromDedicatedCells(cells, cols ?? null) : null;
  if (dedicated) return dedicated;

  const normalized = text
    .replace(/\u00a0/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/\s*([/:_-])\s*/g, "$1")
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

  if (!best || best.score < 25) return null;

  return best.candidate.value;
}

/* --------------------------- row amount utils ---------------------- */

type RowValue = {
  index: number;
  value: number;
};

function rowValues(cells: Row, cols: ColumnMap | null): RowValue[] {
  if (cells.length === 1) {
    return moneyTokens(cells[0] || "").map((t, i) => ({
      index: i,
      value: toNumber(t),
    }));
  }

  const out: RowValue[] = [];

  cells.forEach((cell, i) => {
    if (cols?.date === i || cols?.narration === i) return;

    const v = cellAmount(cell || "");
    if (v !== null) out.push({ index: i, value: v });
  });

  return out;
}

/* --------------------------- direction engine ---------------------- */

/**
 * Direction priority:
 * 1. Dedicated debit/credit columns
 * 2. Explicit row type field (DR/CR)
 * 3. Negative transaction amount
 * 4. Balance delta
 * 5. Narration keywords only as final fallback
 *
 * IMPORTANT:
 * A trailing CR/DR attached to BALANCE is NOT treated as transaction direction.
 */
function classifyDebit(
  cells: Row,
  text: string,
  cols: ColumnMap | null,
  prevBalance: number | null,
): {
  isDebit: boolean;
  amount: number | null;
  balance: number | null;
} {
  const values = rowValues(cells, cols);

  let balance: number | null = null;
  let balanceIdx: number | null = null;

  if (cols?.balance !== undefined) {
    const v = cellAmount(cells[cols.balance] || "");
    if (v !== null) {
      balance = Math.abs(v);
      balanceIdx = cols.balance;
    }
  } else if (values.length >= 2) {
    const last = values[values.length - 1]!;
    balance = Math.abs(last.value);
    balanceIdx = last.index;
  }

  // 1. Dedicated Debit/Credit columns are authoritative.
  const debitCell =
    cols?.debit !== undefined ? cellAmount(cells[cols.debit] || "") : null;

  const creditCell =
    cols?.credit !== undefined ? cellAmount(cells[cols.credit] || "") : null;

  if (debitCell !== null && debitCell !== 0) {
    return {
      isDebit: true,
      amount: Math.abs(debitCell),
      balance,
    };
  }

  if (creditCell !== null && creditCell !== 0) {
    return {
      isDebit: false,
      amount: Math.abs(creditCell),
      balance,
    };
  }

  // 2. Explicit type column or standalone DR/CR cell.
  const typeCell =
    cols?.type !== undefined ? cells[cols.type] || "" : "";

  const indicator =
    typeCell ||
    cells.find((c) => /^\s*(dr|debit|cr|credit|d|c)\.?\s*$/i.test(c || "")) ||
    "";

  if (indicator) {
    if (/^\s*(dr|debit|d)\.?\s*$/i.test(indicator)) {
      const nonBalance = values.filter((v) => v.index !== balanceIdx);
      const candidate = nonBalance.find((v) => Math.abs(v.value) > 0);
      return {
        isDebit: true,
        amount: candidate ? Math.abs(candidate.value) : null,
        balance,
      };
    }

    if (/^\s*(cr|credit|c)\.?\s*$/i.test(indicator)) {
      return {
        isDebit: false,
        amount: null,
        balance,
      };
    }
  }

  const nonBalance = values.filter((v) => v.index !== balanceIdx);

  // 3. Negative transaction amount is strong debit evidence.
  const negative = nonBalance.find((v) => v.value < 0);
  if (negative) {
    return {
      isDebit: true,
      amount: Math.abs(negative.value),
      balance,
    };
  }

  // 4. Balance delta.
  if (balance !== null && prevBalance !== null) {
    const delta = Number((balance - prevBalance).toFixed(2));

    if (delta < 0) {
      const match = nonBalance.find(
        (v) => Math.abs(Math.abs(v.value) - Math.abs(delta)) < 0.02,
      );

      return {
        isDebit: true,
        amount: match ? Math.abs(match.value) : Math.abs(delta),
        balance,
      };
    }

    if (delta > 0) {
      return {
        isDebit: false,
        amount: null,
        balance,
      };
    }
  }

  // 5. Narration keyword fallback only when there is no contradictory evidence.
  const narrationOnly = text.replace(BALANCE_WORDS, " ");
  const d = DEBIT_WORDS.test(narrationOnly);
  const c = CREDIT_WORDS.test(narrationOnly);

  if (d && !c) {
    const candidate = nonBalance.find((v) => Math.abs(v.value) > 0);
    return {
      isDebit: true,
      amount: candidate ? Math.abs(candidate.value) : null,
      balance,
    };
  }

  return {
    isDebit: false,
    amount: null,
    balance,
  };
}

/* ------------------------------ engine ------------------------------ */

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
      if (t.length) prevBalance = Math.abs(toNumber(t[t.length - 1] ?? ""));
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

    let currentBalance: number | null = null;

    if (rowCols?.balance !== undefined) {
      const v = cellAmount(cells[rowCols.balance] || "");
      if (v !== null) currentBalance = Math.abs(v);
    } else if (values.length >= 2) {
      currentBalance = Math.abs(values[values.length - 1]!.value);
    }

    const previousBalance = prevBalance;
    if (currentBalance !== null) prevBalance = currentBalance;

    // Exclude obvious non-payment debit categories.
    // But do not exclude "payment" itself because UPI/IMPS debit narration may use it.
    if (EXCLUDE_RE.test(text)) continue;

    const mode = detectMode(text);
    if (!mode) continue;

    const classified = classifyDebit(
      cells,
      text,
      rowCols,
      previousBalance,
    );

    if (!classified.isDebit) continue;

    let amount = classified.amount;

    if ((amount === null || amount <= 0) && rowCols?.amount !== undefined) {
      const a = cellAmount(cells[rowCols.amount] || "");
      if (a !== null) amount = Math.abs(a);
    }

    if (amount === null || amount <= 0) {
      const nonBalance = values.filter(
        (v) =>
          rowCols?.balance === undefined ||
          v.index !== rowCols.balance,
      );

      const candidate =
        nonBalance.find((v) => v.value < 0) ??
        nonBalance.find((v) => Math.abs(v.value) > 0);

      if (candidate) amount = Math.abs(candidate.value);
    }

    if (!amount || amount <= 0) continue;

    // Reference extraction is independent from debit validity.
    const ref = extractDebitRef(text, mode, cells, rowCols);

    results.push({
      date,
      utr: ref ?? "N/A",
      amount: fmtAmount(amount),
      mode,
    });
  }

  return {
    rows: dedupeDebits(results),
  };
}

/* ------------------------------ inputs ------------------------------ */

/**
 * Text/PDF statements frequently wrap one transaction across multiple lines.
 * Any continuation line without a new transaction date is appended to the
 * previous dated line.
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
    const key = `${r.date}|${r.utr}|${r.amount}|${r.mode}`;

    if (seen.has(key)) return false;

    seen.add(key);
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
