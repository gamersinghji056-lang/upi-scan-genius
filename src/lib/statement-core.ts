/* ========================================================================== *
 * UNIVERSAL INDIAN BANK STATEMENT CORE — V2
 *
 * READ -> RECONSTRUCT -> UNDERSTAND -> CLASSIFY -> VALIDATE
 *
 * Supported normalized sources:
 * - Native bank PDF text
 * - OCR PDF rows
 * - XLS / XLSX
 * - CSV
 * - TXT / fixed-width text
 *
 * IMPORTANT RULES
 *
 * 1. Mode NEVER decides debit / credit.
 * 2. Transaction DR/CR and Balance DR/CR are different.
 * 3. Dedicated Debit/Credit columns have highest authority.
 * 4. Valid transaction is NOT dropped because UTR is missing.
 * 5. Reverse-chronological statements are supported.
 * 6. One-cell flattened PDF rows are supported.
 * 7. UTR/reference is scored independently from direction and amount.
 * ========================================================================== */

export type Row = string[];

export type Direction =
  | "credit"
  | "debit"
  | "unknown";

export type PaymentMode =
  | "UPI"
  | "IMPS"
  | "NEFT"
  | "RTGS"
  | "OTHER";

export type Confidence =
  | "high"
  | "medium"
  | "low";

export type StatementOrder =
  | "ascending"
  | "descending"
  | "unknown";

export type ColumnMap = {
  serial?: number;
  date?: number;
  valueDate?: number;
  narration?: number;
  reference?: number;
  debit?: number;
  credit?: number;
  amount?: number;
  type?: number;
  balance?: number;
  balanceType?: number;
  channel?: number;
};

export type CoreTransaction = {
  date: string;
  rawDate: string;
  narration: string;
  reference: string | null;
  amount: number | null;
  direction: Direction;
  mode: PaymentMode;
  balance: number | null;
  confidence: Confidence;
  raw: string;
  rowIndex: number;
  reasons: string[];
};

export type StatementSummary = {
  transactionCount?: number;
  debitCount?: number;
  creditCount?: number;
  debitAmount?: number;
  creditAmount?: number;
  openingBalance?: number;
  closingBalance?: number;
};

export type CoreResult = {
  transactions: CoreTransaction[];
  columns: ColumnMap | null;
  summary: StatementSummary | null;
  warnings: string[];
};

/* ========================================================================== *
 * NORMALIZATION
 * ========================================================================== */

export function normalizeText(
  value: unknown,
): string {
  return String(
    value ?? "",
  )
    .replace(
      /\u00a0/g,
      " ",
    )
    .replace(
      /[\u200B-\u200D\uFEFF]/g,
      "",
    )
    .replace(
      /[‐-‒–—]/g,
      "-",
    )
    .replace(
      /[“”]/g,
      '"',
    )
    .replace(
      /[‘’]/g,
      "'",
    )
    .replace(
      /\s+/g,
      " ",
    )
    .trim();
}

export function compactText(
  value: unknown,
): string {
  return normalizeText(
    value,
  ).replace(
    /\s*([/:_=\-])\s*/g,
    "$1",
  );
}

function rowText(
  row: Row,
): string {
  return normalizeText(
    row.join(" "),
  );
}

/* ========================================================================== *
 * DATE
 * ========================================================================== */

const MONTHS:
  Record<string, string> = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12",
  };

function pad2(
  value: string,
): string {
  return value.padStart(
    2,
    "0",
  );
}

function normalizeYear(
  value: string,
): string {
  if (
    value.length === 4
  ) {
    return value;
  }

  return Number(value) >= 70
    ? `19${value}`
    : `20${value}`;
}

/**
 * Excel serial date support.
 */
export function excelSerialToDate(
  value: string,
): string | null {
  const input =
    value.trim();

  if (
    !/^\d+(?:\.0+)?$/.test(
      input,
    )
  ) {
    return null;
  }

  const serial =
    Number(input);

  if (
    serial < 36526 ||
    serial > 73050
  ) {
    return null;
  }

  const milliseconds =
    Math.round(
      (serial - 25569) *
        86400 *
        1000,
    );

  const date =
    new Date(
      milliseconds,
    );

  if (
    Number.isNaN(
      date.getTime(),
    )
  ) {
    return null;
  }

  return [
    pad2(
      String(
        date.getUTCDate(),
      ),
    ),
    pad2(
      String(
        date.getUTCMonth() + 1,
      ),
    ),
    String(
      date.getUTCFullYear(),
    ),
  ].join("/");
}

/**
 * Returns DD/MM/YYYY.
 */
export function extractDate(
  input: string,
): string | null {
  const text =
    normalizeText(
      input,
    );

  if (!text) {
    return null;
  }

  const excel =
    excelSerialToDate(
      text,
    );

  if (excel) {
    return excel;
  }

  let match:
    RegExpExecArray | null;

  // DD/MM/YYYY
  match =
    /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/.exec(
      text,
    );

  if (match) {
    return [
      pad2(match[1] ?? ""),
      pad2(match[2] ?? ""),
      match[3] ?? "",
    ].join("/");
  }

  // YYYY/MM/DD
  match =
    /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(
      text,
    );

  if (match) {
    return [
      pad2(match[3] ?? ""),
      pad2(match[2] ?? ""),
      match[1] ?? "",
    ].join("/");
  }

  // DD-MMM-YYYY
  match =
    /\b(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{2,4})\b/.exec(
      text,
    );

  if (match) {
    const month =
      MONTHS[
        (match[2] ?? "")
          .slice(0, 3)
          .toLowerCase()
      ];

    if (month) {
      return [
        pad2(match[1] ?? ""),
        month,
        normalizeYear(
          match[3] ?? "",
        ),
      ].join("/");
    }
  }

  // DD/MM/YY
  match =
    /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})\b/.exec(
      text,
    );

  if (match) {
    return [
      pad2(match[1] ?? ""),
      pad2(match[2] ?? ""),
      normalizeYear(
        match[3] ?? "",
      ),
    ].join("/");
  }

  return null;
}

function dateNumber(
  input: string,
): number | null {
  const normalized =
    extractDate(
      input,
    );

  if (!normalized) {
    return null;
  }

  const parts =
    normalized.split("/");

  const day =
    Number(parts[0]);

  const month =
    Number(parts[1]);

  const year =
    Number(parts[2]);

  if (
    !day ||
    !month ||
    !year
  ) {
    return null;
  }

  return Date.UTC(
    year,
    month - 1,
    day,
  );
}

/* ========================================================================== *
 * MONEY
 * ========================================================================== */

export function parseMoney(
  input: unknown,
): number | null {
  const original =
    normalizeText(
      input,
    );

  if (
    !original ||
    original === "-" ||
    original === "--"
  ) {
    return null;
  }

  if (
    /[-/.]/.test(original) &&
    extractDate(original) !== null
  ) {
    return null;
  }

  if (
    /^\d{1,2}:\d{2}(?::\d{2})?$/.test(
      original,
    )
  ) {
    return null;
  }

  const bracketNegative =
    /^\(.*\)$/.test(
      original,
    );

  const cleaned =
    original
      .replace(/₹/g, "")
      .replace(/,/g, "")
      .replace(/\s+/g, "")
      .replace(/[()]/g, "")
      .replace(/(CR|DR)$/i, "");

  if (
    !/^[+-]?\d+(?:\.\d{1,2})?$/.test(
      cleaned,
    )
  ) {
    return null;
  }

  let value =
    Number(cleaned);

  if (
    !Number.isFinite(
      value,
    )
  ) {
    return null;
  }

  if (
    bracketNegative
  ) {
    value =
      -Math.abs(value);
  }

  return value;
}

function extractMoneyTokens(
  input: string,
): number[] {
  let text =
    normalizeText(
      input,
    );

  text =
    text.replace(
      /\b\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}\b/g,
      " ",
    );

  text =
    text.replace(
      /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
      " ",
    );

  text =
    text.replace(
      /(?<!\d)\d{7,30}(?!\d)/g,
      " ",
    );

  const regex =
    /(?:₹\s*)?(\(?[+-]?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?\)?|\(?[+-]?\d+(?:\.\d{1,2})?\)?)/g;

  const results:
    number[] = [];

  let match:
    RegExpExecArray | null;

  while (
    (match = regex.exec(text)) !== null
  ) {
    const value =
      parseMoney(
        match[1] ?? "",
      );

    if (
      value !== null
    ) {
      results.push(
        value,
      );
    }
  }

  return results;
}

function parseCompoundMoneyCell(
  input: string,
): {
  first: number | null;
  second: number | null;
} {
  const values =
    extractMoneyTokens(
      input,
    );

  return {
    first:
      values[0] ?? null,
    second:
      values[1] ?? null,
  };
}
