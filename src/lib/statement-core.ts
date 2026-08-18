/* ========================================================================== *
 * UNIVERSAL INDIAN BANK STATEMENT CORE
 *
 * Goal:
 *   Understand a transaction BEFORE deciding whether UI should display it.
 *
 * Supported input after statement-readers normalization:
 *   PDF native text
 *   PDF OCR text
 *   XLS/XLSX rows
 *   CSV rows
 *   TXT/fixed width rows
 *
 * Pipeline:
 *
 *   INPUT
 *     ↓
 *   normalize
 *     ↓
 *   detect table/header
 *     ↓
 *   rebuild wrapped transactions
 *     ↓
 *   detect date
 *     ↓
 *   detect amount + direction
 *     ↓
 *   detect payment mode
 *     ↓
 *   score/extract reference
 *     ↓
 *   validate against balance / statement summary
 *     ↓
 *   CoreTransaction[]
 *
 * IMPORTANT:
 *
 * - Mode NEVER decides debit/credit direction.
 * - Balance CR/DR NEVER automatically means transaction CR/DR.
 * - Valid transaction is not dropped because UTR is missing.
 * - Reference column is evidence, not absolute truth.
 * - UTR/reference is scored from all available row information.
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
  )
    .replace(
      /\s*([/:_\-=])\s*/g,
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
 * DATE ENGINE
 * ========================================================================== */

const MONTHS: Record<
  string,
  string
> = {
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

  const year =
    Number(value);

  return year >= 70
    ? `19${value}`
    : `20${value}`;
}

/**
 * Excel numeric date.
 *
 * Excel serial 1 = 01/01/1900 approximately.
 *
 * We accept safe banking-statement range only.
 */
export function excelSerialToDate(
  value: string,
): string | null {
  if (
    !/^\d+(?:\.0+)?$/.test(
      value.trim(),
    )
  ) {
    return null;
  }

  const serial =
    Number(value);

  /*
   * Reasonable range:
   * approx 2000 - 2100.
   */
  if (
    serial < 36526 ||
    serial > 73050
  ) {
    return null;
  }

  /*
   * Excel incorrectly considers 1900 leap year.
   * Unix conversion normally uses 25569.
   */
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
        date.getUTCMonth() +
          1,
      ),
    ),

    date.getUTCFullYear(),
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

  /*
   * Excel serial.
   */
  const excel =
    excelSerialToDate(
      text,
    );

  if (excel) {
    return excel;
  }

  let match:
    RegExpExecArray | null;

  /*
   * DD/MM/YYYY
   */
  match =
    /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/.exec(
      text,
    );

  if (match) {
    return [
      pad2(
        match[1] ?? "",
      ),
      pad2(
        match[2] ?? "",
      ),
      match[3],
    ].join("/");
  }

  /*
   * YYYY/MM/DD
   */
  match =
    /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(
      text,
    );

  if (match) {
    return [
      pad2(
        match[3] ?? "",
      ),
      pad2(
        match[2] ?? "",
      ),
      match[1],
    ].join("/");
  }

  /*
   * DD-MMM-YYYY
   */
  match =
    /\b(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{2,4})\b/.exec(
      text,
    );

  if (match) {
    const month =
      MONTHS[
        (
          match[2] ?? ""
        )
          .slice(
            0,
            3,
          )
          .toLowerCase()
      ];

    if (month) {
      return [
        pad2(
          match[1] ?? "",
        ),
        month,
        normalizeYear(
          match[3] ?? "",
        ),
      ].join("/");
    }
  }

  /*
   * DD/MM/YY
   */
  match =
    /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})\b/.exec(
      text,
    );

  if (match) {
    return [
      pad2(
        match[1] ?? "",
      ),
      pad2(
        match[2] ?? "",
      ),
      normalizeYear(
        match[3] ?? "",
      ),
    ].join("/");
  }

  return null;
}

/* ========================================================================== *
 * MONEY ENGINE
 * ========================================================================== */

/**
 * Parses a cell that itself is expected to contain a money value.
 *
 * Examples:
 *
 * 1,20,800.00
 * ₹ 50,000
 * -711.00
 * (500.00)
 * 500 CR
 */
export function parseMoney(
  input: unknown,
): number | null {
  const original =
    normalizeText(
      input,
    );

  if (!original) {
    return null;
  }

  if (
    original === "-" ||
    original === "--"
  ) {
    return null;
  }

  /*
   * Prevent date being interpreted as money.
   */
  if (
    extractDate(
      original,
    ) !== null &&
    /[-/.]/.test(
      original,
    )
  ) {
    return null;
  }

  /*
   * Prevent simple time.
   */
  if (
    /^\d{1,2}:\d{2}(?::\d{2})?$/.test(
      original,
    )
  ) {
    return null;
  }

  const brackets =
    /^\(.*\)$/.test(
      original,
    );

  let value =
    original
      .replace(
        /₹/g,
        "",
      )
      .replace(
        /,/g,
        "",
      )
      .replace(
        /\s+/g,
        "",
      )
      .replace(
        /[()]/g,
        "",
      )
      .replace(
        /(CR|DR)$/i,
        "",
      );

  if (
    !/^[+-]?\d+(?:\.\d{1,2})?$/.test(
      value,
    )
  ) {
    return null;
  }

  let number =
    Number(value);

  if (
    !Number.isFinite(
      number,
    )
  ) {
    return null;
  }

  if (brackets) {
    number =
      -Math.abs(
        number,
      );
  }

  return number;
}

function extractMoneyTokens(
  input: string,
): number[] {
  let text =
    normalizeText(
      input,
    );

  /*
   * Remove dates first.
   */
  text =
    text.replace(
      /\b\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}\b/g,
      " ",
    );

  /*
   * Remove time.
   */
  text =
    text.replace(
      /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
      " ",
    );

  /*
   * Remove long pure references before looking for money.
   */
  text =
    text.replace(
      /(?<!\d)\d{7,30}(?!\d)/g,
      " ",
    );

  const regex =
    /(?:₹\s*)?(\(?-?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?\)?|\(?-?\d+(?:\.\d{1,2})?\)?)/g;

  const results:
    number[] = [];

  let match:
    RegExpExecArray | null;

  while (
    (
      match =
        regex.exec(
          text,
        )
    ) !== null
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

/* ========================================================================== *
 * COLUMN DETECTION
 * ========================================================================== */

const SERIAL_HEADER =
  /^(s\.?\s*no\.?|sr\.?\s*no\.?|serial|sl\.?\s*no\.?)$/i;

const DATE_HEADER =
  /\b(transaction\s*date|tran\.?\s*date|txn\s*date|posting\s*date|post\s*date|date)\b/i;

const VALUE_DATE_HEADER =
  /\b(value\s*date|effective\s*date)\b/i;

const NARRATION_HEADER =
  /\b(particulars?|narration|description|remarks?|details?|transaction\s*details?|transaction\s*description|account\s*description)\b/i;

const REFERENCE_HEADER =
  /\b(chq\s*\/?\s*ref(?:erence)?\s*(?:no)?|cheque\s*\/?\s*reference|cheque\s*no|reference\s*(?:no|number)?|ref\.?\s*no|utr|rrn|transaction\s*id|txn\s*id|instrument\s*id|instrument\s*no|inst\.?\s*no)\b/i;

const DEBIT_HEADER =
  /\b(debit\s*amount|debit|dr\.?\s*amount|withdrawal|withdrawals|withdraw|withdrawn)\b/i;

const CREDIT_HEADER =
  /\b(credit\s*amount|credit|cr\.?\s*amount|deposit|deposits|deposited)\b/i;

const TYPE_HEADER =
  /\b(debit\s*\/\s*credit|credit\s*\/\s*debit|dr\s*\/\s*cr|cr\s*\/\s*dr|transaction\s*type|txn\s*type|type|indicator)\b/i;

const BALANCE_HEADER =
  /\b(closing\s*balance|running\s*balance|available\s*balance|balance\s*\(inr\)|balance)\b/i;

const AMOUNT_HEADER =
  /\b(transaction\s*amount|txn\s*amount|amount\s*\(inr\)|amount|value)\b/i;

const CHANNEL_HEADER =
  /\b(channel|mode|transaction\s*channel)\b/i;

function cleanHeader(
  input: string,
): string {
  return normalizeText(
    input,
  )
    .toLowerCase()
    .replace(
      /[.:]+/g,
      " ",
    )
    .replace(
      /\s+/g,
      " ",
    )
    .trim();
}

/**
 * Detect one table header.
 *
 * The important distinction:
 *
 * "Debit/Credit"      => transaction type column
 * "Balance Dr / Cr"   => balance type, NOT transaction type
 */
export function detectColumns(
  header: Row,
): ColumnMap | null {
  const map:
    ColumnMap = {};

  let evidence = 0;

  header.forEach(
    (
      raw,
      index,
    ) => {
      const text =
        cleanHeader(
          raw,
        );

      if (
        !text ||
        text.length > 120
      ) {
        return;
      }

      if (
        SERIAL_HEADER.test(
          text,
        )
      ) {
        map.serial ??=
          index;

        return;
      }

      if (
        VALUE_DATE_HEADER.test(
          text,
        )
      ) {
        map.valueDate ??=
          index;

        evidence++;

        return;
      }

      if (
        DATE_HEADER.test(
          text,
        )
      ) {
        map.date ??=
          index;

        evidence++;

        return;
      }

      if (
        NARRATION_HEADER.test(
          text,
        )
      ) {
        map.narration ??=
          index;

        evidence++;

        return;
      }

      if (
        REFERENCE_HEADER.test(
          text,
        )
      ) {
        map.reference ??=
          index;

        evidence++;

        return;
      }

      /*
       * Balance type must be checked before generic Type.
       */
      if (
        BALANCE_HEADER.test(
          text,
        ) &&
        /\b(?:dr|cr)\b/i.test(
          text,
        )
      ) {
        map.balanceType ??=
          index;

        return;
      }

      if (
        BALANCE_HEADER.test(
          text,
        )
      ) {
        map.balance ??=
          index;

        evidence++;

        return;
      }

      if (
        CHANNEL_HEADER.test(
          text,
        )
      ) {
        map.channel ??=
          index;

        return;
      }

      /*
       * Combined Debit/Credit = type indicator.
       */
      if (
        TYPE_HEADER.test(
          text,
        ) ||
        (
          DEBIT_HEADER.test(
            text,
          ) &&
          CREDIT_HEADER.test(
            text,
          )
        )
      ) {
        map.type ??=
          index;

        evidence++;

        return;
      }

      if (
        DEBIT_HEADER.test(
          text,
        )
      ) {
        map.debit ??=
          index;

        evidence++;

        return;
      }

      if (
        CREDIT_HEADER.test(
          text,
        )
      ) {
        map.credit ??=
          index;

        evidence++;

        return;
      }

      if (
        AMOUNT_HEADER.test(
          text,
        )
      ) {
        map.amount ??=
          index;

        evidence++;
      }
    },
  );

  /*
   * Avoid mistaking account-details rows for table headers.
   */
  if (
    evidence < 2
  ) {
    return null;
  }

  return map;
}

/**
 * Scores a column map.
 */
function columnScore(
  map: ColumnMap,
): number {
  let score = 0;

  if (
    map.date !== undefined
  ) {
    score += 4;
  }

  if (
    map.narration !==
    undefined
  ) {
    score += 4;
  }

  if (
    map.debit !== undefined
  ) {
    score += 4;
  }

  if (
    map.credit !==
    undefined
  ) {
    score += 4;
  }

  if (
    map.amount !==
    undefined
  ) {
    score += 3;
  }

  if (
    map.type !== undefined
  ) {
    score += 3;
  }

  if (
    map.balance !==
    undefined
  ) {
    score += 3;
  }

  if (
    map.reference !==
    undefined
  ) {
    score += 2;
  }

  return score;
}

/**
 * Supports multi-line headers.
 *
 * Example:
 *
 * row 1: Chq /       Dr /
 * row 2: Ref No.     Cr
 */
export function findColumns(
  rows: Row[],
): {
  columns: ColumnMap | null;

  headerIndex: number;

  headerDepth: number;
} {
  const maxRows =
    Math.min(
      rows.length,
      100,
    );

  let best:
    | {
        columns: ColumnMap;
        headerIndex: number;
        headerDepth: number;
        score: number;
      }
    | null = null;

  for (
    let index = 0;
    index < maxRows;
    index++
  ) {
    const first =
      rows[index] ?? [];

    /*
     * Single row.
     */
    const candidates: Array<{
      row: Row;
      depth: number;
    }> = [
      {
        row: first,
        depth: 1,
      },
    ];

    /*
     * 2-row combined header.
     */
    if (
      rows[index + 1]
    ) {
      const second =
        rows[
          index + 1
        ] ?? [];

      const width =
        Math.max(
          first.length,
          second.length,
        );

      const combined:
        Row = [];

      for (
        let col = 0;
        col < width;
        col++
      ) {
        combined[col] =
          normalizeText(
            `${first[col] ?? ""} ${
              second[col] ?? ""
            }`,
          );
      }

      candidates.push({
        row:
          combined,

        depth:
          2,
      });
    }

    for (
      const candidate of
        candidates
    ) {
      const map =
        detectColumns(
          candidate.row,
        );

      if (!map) {
        continue;
      }

      const score =
        columnScore(
          map,
        );

      if (
        !best ||
        score >
          best.score
      ) {
        best = {
          columns:
            map,

          headerIndex:
            index,

          headerDepth:
            candidate.depth,

          score,
        };
      }
    }
  }

  return best
    ? {
        columns:
          best.columns,

        headerIndex:
          best.headerIndex,

        headerDepth:
          best.headerDepth,
      }
    : {
        columns:
          null,

        headerIndex:
          -1,

        headerDepth:
          0,
      };
}

/* ========================================================================== *
 * TRANSACTION ROW IDENTIFICATION
 * ========================================================================== */

function hasDate(
  row: Row,
): boolean {
  return row.some(
    (cell) =>
      extractDate(
        cell,
      ) !== null,
  );
}

function isHeaderRow(
  row: Row,
): boolean {
  return (
    detectColumns(
      row,
    ) !== null
  );
}

function isStatementMetadata(
  row: Row,
): boolean {
  const text =
    rowText(
      row,
    );

  if (!text) {
    return true;
  }

  /*
   * Skip headers/footers only when row has no transaction date.
   */
  if (hasDate(row)) {
    return false;
  }

  return (
    /\b(account\s*(?:no|number)|customer\s*(?:id|name|number)|branch\s*(?:name|code|address)|ifsc|micr|statement\s*(?:of\s*account)?|nominee|currency|registered\s*mobile|registered\s*email|page\s+\d+\s+of\s+\d+)\b/i.test(
      text,
    )
  );
}

/**
 * Merge wrapped rows column-wise.
 *
 * IMPORTANT:
 * A wrapped narration should remain attached to same transaction.
 */
export function reconstructRows(
  rows: Row[],
  startIndex = 0,
): Row[] {
  const output:
    Row[] = [];

  let current:
    Row | null = null;

  for (
    let index =
      Math.max(
        0,
        startIndex,
      );
    index < rows.length;
    index++
  ) {
    const row =
      (
        rows[index] ?? []
      ).map(
        (
          cell,
        ) =>
          normalizeText(
            cell,
          ),
      );

    if (
      !row.some(
        Boolean,
      )
    ) {
      continue;
    }

    /*
     * Repeated header on new page.
     */
    if (
      isHeaderRow(
        row,
      )
    ) {
      if (current) {
        output.push(
          current,
        );

        current =
          null;
      }

      continue;
    }

    if (
      isStatementMetadata(
        row,
      )
    ) {
      continue;
    }

    const dated =
      hasDate(
        row,
      );

    if (dated) {
      if (current) {
        output.push(
          current,
        );
      }

      current =
        [...row];

      continue;
    }

    /*
     * No active transaction:
     * ignore footer/summary/nontransaction content.
     */
    if (!current) {
      continue;
    }

    /*
     * Continuation row.
     */
    const width =
      Math.max(
        current.length,
        row.length,
      );

    for (
      let col = 0;
      col < width;
      col++
    ) {
      const extra =
        row[col] ?? "";

      if (!extra) {
        continue;
      }

      current[col] =
        normalizeText(
          `${current[col] ?? ""} ${extra}`,
        );
    }
  }

  if (current) {
    output.push(
      current,
    );
  }

  return output;
}

/* ========================================================================== *
 * INDICATORS
 * ========================================================================== */

function indicatorDirection(
  input: string,
): Direction {
  const value =
    normalizeText(
      input,
    )
      .replace(
        /\./g,
        "",
      )
      .toUpperCase();

  if (
    /^(CR|C|CREDIT|CREDITED|DEPOSIT)$/.test(
      value,
    )
  ) {
    return "credit";
  }

  if (
    /^(DR|D|DEBIT|DEBITED|WITHDRAW|WITHDRAWAL)$/.test(
      value,
    )
  ) {
    return "debit";
  }

  return "unknown";
}

/**
 * Narration direction should be LAST RESORT.
 */
function narrationDirection(
  narration: string,
): Direction {
  const text =
    compactText(
      narration,
    );

  if (
    /(?:^|[/_: -])UPI[/_: -]+CR(?:[/_: -]|$)/i.test(
      text,
    )
  ) {
    return "credit";
  }

  if (
    /(?:^|[/_: -])UPI[/_: -]+DR(?:[/_: -]|$)/i.test(
      text,
    )
  ) {
    return "debit";
  }

  if (
    /\b(?:credited|credit received|amount received|deposit received)\b/i.test(
      text,
    )
  ) {
    return "credit";
  }

  if (
    /\b(?:debited|amount debited|withdrawn)\b/i.test(
      text,
    )
  ) {
    return "debit";
  }

  return "unknown";
}

/* ========================================================================== *
 * DIRECTION + AMOUNT
 * ========================================================================== */

type ClassifiedTransaction = {
  direction: Direction;

  amount: number | null;

  balance: number | null;

  reasons: string[];
};

function parseCellAt(
  row: Row,
  index:
    | number
    | undefined,
): number | null {
  if (
    index === undefined
  ) {
    return null;
  }

  return parseMoney(
    row[index] ?? "",
  );
}

/**
 * Some bad Excel/PDF conversions concatenate amount + balance.
 *
 * Example:
 *
 * Deposit cell:
 *
 *   "6000.00 302376.95"
 *
 * There should have been:
 *
 *   Deposit = 6000
 *   Balance = 302376.95
 *
 * In this situation:
 * first number = transaction amount
 * second number = balance candidate
 */
function parseCompoundMoneyCell(
  input: string,
): {
  first: number | null;

  second: number | null;
} {
  const numbers =
    extractMoneyTokens(
      input,
    );

  return {
    first:
      numbers[0] ??
      null,

    second:
      numbers[1] ??
      null,
  };
}

function extractBalance(
  row: Row,
  columns:
    | ColumnMap
    | null,
): number | null {
  if (
    columns?.balance !==
    undefined
  ) {
    const direct =
      parseCellAt(
        row,
        columns.balance,
      );

    if (
      direct !== null
    ) {
      return Math.abs(
        direct,
      );
    }
  }

  /*
   * Some malformed exports have amount+balance in Debit/Credit cells.
   */
  for (
    const index of [
      columns?.debit,
      columns?.credit,
      columns?.amount,
    ]
  ) {
    if (
      index === undefined
    ) {
      continue;
    }

    const compound =
      parseCompoundMoneyCell(
        row[index] ??
          "",
      );

    if (
      compound.second !==
      null
    ) {
      return Math.abs(
        compound.second,
      );
    }
  }

  return null;
}

/**
 * DIRECTION AUTHORITY:
 *
 * 1. Separate Debit / Credit columns
 * 2. Transaction DR/CR column
 * 3. Signed single Amount
 * 4. Balance delta
 * 5. Strong narration marker
 *
 * Never use balance-type CR/DR as transaction direction.
 */
function classifyTransaction(
  row: Row,
  columns:
    | ColumnMap
    | null,
  narration: string,
  previousBalance:
    | number
    | null,
): ClassifiedTransaction {
  const reasons:
    string[] = [];

  const balance =
    extractBalance(
      row,
      columns,
    );

  /* ---------------------------------------------------------------- *
   * 1. DEDICATED DEBIT / CREDIT
   * ---------------------------------------------------------------- */

  if (
    columns?.debit !==
      undefined ||
    columns?.credit !==
      undefined
  ) {
    const debitCompound =
      columns.debit !==
      undefined
        ? parseCompoundMoneyCell(
            row[
              columns.debit
            ] ?? "",
          )
        : {
            first: null,
            second: null,
          };

    const creditCompound =
      columns.credit !==
      undefined
        ? parseCompoundMoneyCell(
            row[
              columns.credit
            ] ?? "",
          )
        : {
            first: null,
            second: null,
          };

    const debit =
      debitCompound.first;

    const credit =
      creditCompound.first;

    /*
     * One side should normally be populated.
     */
    if (
      debit !== null &&
      Math.abs(debit) >
        0 &&
      (
        credit === null ||
        Math.abs(credit) ===
          0
      )
    ) {
      reasons.push(
        "dedicated debit column",
      );

      return {
        direction:
          "debit",

        amount:
          Math.abs(
            debit,
          ),

        balance,

        reasons,
      };
    }

    if (
      credit !== null &&
      Math.abs(credit) >
        0 &&
      (
        debit === null ||
        Math.abs(debit) ===
          0
      )
    ) {
      reasons.push(
        "dedicated credit column",
      );

      return {
        direction:
          "credit",

        amount:
          Math.abs(
            credit,
          ),

        balance,

        reasons,
      };
    }

    /*
     * If both appear numeric due malformed row,
     * balance reconciliation will decide later.
     */
  }

  /* ---------------------------------------------------------------- *
   * 2. EXPLICIT TRANSACTION TYPE
   * ---------------------------------------------------------------- */

  if (
    columns?.type !==
    undefined
  ) {
    const direction =
      indicatorDirection(
        row[
          columns.type
        ] ?? "",
      );

    if (
      direction !==
      "unknown"
    ) {
      let amount =
        parseCellAt(
          row,
          columns.amount,
        );

      if (
        amount === null
      ) {
        /*
         * Find transaction-looking numeric values,
         * excluding date / reference / balance.
         */
        const candidates:
          number[] = [];

        row.forEach(
          (
            cell,
            index,
          ) => {
            if (
              index ===
                columns.date ||
              index ===
                columns.valueDate ||
              index ===
                columns.reference ||
              index ===
                columns.balance ||
              index ===
                columns.balanceType ||
              index ===
                columns.serial
            ) {
              return;
            }

            const value =
              parseMoney(
                cell,
              );

            if (
              value !==
              null
            ) {
              candidates.push(
                value,
              );
            }
          },
        );

        amount =
          candidates[0] ??
          null;
      }

      if (
        amount !== null
      ) {
        reasons.push(
          "explicit transaction DR/CR",
        );

        return {
          direction,

          amount:
            Math.abs(
              amount,
            ),

          balance,

          reasons,
        };
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * 3. SINGLE AMOUNT COLUMN
   * ---------------------------------------------------------------- */

  if (
    columns?.amount !==
    undefined
  ) {
    const value =
      parseCellAt(
        row,
        columns.amount,
      );

    if (
      value !== null &&
      value < 0
    ) {
      reasons.push(
        "negative amount column",
      );

      return {
        direction:
          "debit",

        amount:
          Math.abs(
            value,
          ),

        balance,

        reasons,
      };
    }
  }

  /* ---------------------------------------------------------------- *
   * Determine amount candidate for remaining rules
   * ---------------------------------------------------------------- */

  let amount =
    parseCellAt(
      row,
      columns?.amount,
    );

  if (
    amount === null
  ) {
    /*
     * One-cell PDF/TXT row.
     */
    const tokens =
      extractMoneyTokens(
        rowText(
          row,
        ),
      );

    if (
      tokens.length >= 2
    ) {
      /*
       * Typically:
       * transaction amount + balance.
       */
      amount =
        tokens[
          tokens.length -
            2
        ] ??
        null;
    } else {
      amount =
        tokens[0] ??
        null;
    }
  }

  /* ---------------------------------------------------------------- *
   * 4. BALANCE DELTA
   * ---------------------------------------------------------------- */

  if (
    amount !== null &&
    previousBalance !==
      null &&
    balance !== null
  ) {
    const delta =
      Number(
        (
          balance -
          previousBalance
        ).toFixed(
          2,
        ),
      );

    const difference =
      Math.abs(
        Math.abs(delta) -
          Math.abs(amount),
      );

    const tolerance =
      Math.max(
        0.02,
        Math.abs(
          amount,
        ) *
          0.00001,
      );

    if (
      difference <=
        tolerance &&
      Math.abs(delta) >
        0
    ) {
      reasons.push(
        "running balance reconciliation",
      );

      return {
        direction:
          delta > 0
            ? "credit"
            : "debit",

        amount:
          Math.abs(
            amount,
          ),

        balance,

        reasons,
      };
    }
  }

  /* ---------------------------------------------------------------- *
   * 5. NARRATION
   * ---------------------------------------------------------------- */

  const narrationSignal =
    narrationDirection(
      narration,
    );

  if (
    narrationSignal !==
      "unknown" &&
    amount !== null
  ) {
    reasons.push(
      "strong narration direction marker",
    );

    return {
      direction:
        narrationSignal,

      amount:
        Math.abs(
          amount,
        ),

      balance,

      reasons,
    };
  }

  return {
    direction:
      "unknown",

    amount:
      amount === null
        ? null
        : Math.abs(
            amount,
          ),

    balance,

    reasons,
  };
}

/* ========================================================================== *
 * MODE DETECTION
 * ========================================================================== */

export function detectMode(
  input: string,
): PaymentMode {
  const text =
    compactText(
      input,
    );

  if (
    /\b(?:IBRTGS|ERTGS|RTGS)\b/i.test(
      text,
    )
  ) {
    return "RTGS";
  }

  if (
    /\b(?:IBNEFT|ENEFT|NEFT)\b/i.test(
      text,
    )
  ) {
    return "NEFT";
  }

  if (
    /\bIMPS\b/i.test(
      text,
    ) ||
    /(?:^|[/_: -])P2A(?:[/_: -]|$)/i.test(
      text,
    ) ||
    /\b(?:PSP2A|IMPSP2A)\b/i.test(
      text,
    )
  ) {
    return "IMPS";
  }

  if (
    /\bUPI\b/i.test(
      text,
    ) ||
    /\bBHIM\b/i.test(
      text,
    ) ||
    /\bMPAY\/UPI\b/i.test(
      text,
    ) ||
    /\bTRTR\b/i.test(
      text,
    )
  ) {
    return "UPI";
  }

  return "OTHER";
}

/* ========================================================================== *
 * REFERENCE ENGINE
 * ========================================================================== */

type ReferenceCandidate = {
  value: string;

  score: number;

  source: string;
};

function cleanReference(
  input: string,
): string {
  return normalizeText(
    input,
  )
    .replace(
      /^[\s:;,.()[\]{}<>|]+/,
      "",
    )
    .replace(
      /[\s:;,.()[\]{}<>|]+$/,
      "",
    )
    .replace(
      /^[-_/]+/,
      "",
    )
    .replace(
      /[-_/]+$/,
      "",
    );
}

function looksLikeIfsc(
  value: string,
): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/i.test(
    value,
  );
}

function looksLikeIndianMobile(
  value: string,
): boolean {
  return /^[6-9]\d{9}$/.test(
    value,
  );
}

function looksLikeAccountNumber(
  value: string,
): boolean {
  return /^\d{14,22}$/.test(
    value,
  );
}

function looksLikeDateValue(
  value: string,
): boolean {
  return (
    extractDate(
      value,
    ) !== null
  );
}

function looksLikeMoneyValue(
  value: string,
): boolean {
  return (
    /[.,₹]/.test(
      value,
    ) &&
    parseMoney(
      value,
    ) !== null
  );
}

function usableReference(
  input: string,
): boolean {
  const value =
    cleanReference(
      input,
    );

  const stripped =
    value.replace(
      /[-_/]/g,
      "",
    );

  if (
    stripped.length < 6 ||
    stripped.length > 50
  ) {
    return false;
  }

  if (
    !/\d/.test(
      stripped,
    )
  ) {
    return false;
  }

  if (
    looksLikeIfsc(
      value,
    ) ||
    looksLikeIndianMobile(
      value,
    ) ||
    looksLikeDateValue(
      value,
    ) ||
    looksLikeMoneyValue(
      value,
    )
  ) {
    return false;
  }

  return true;
}

function addRef(
  list:
    ReferenceCandidate[],
  input:
    | string
    | undefined,
  score: number,
  source: string,
) {
  if (!input) {
    return;
  }

  const value =
    cleanReference(
      input,
    );

  if (
    !usableReference(
      value,
    )
  ) {
    return;
  }

  list.push({
    value,

    score,

    source,
  });
}

/**
 * Explicit labels.
 */
function explicitRefCandidates(
  text: string,
): ReferenceCandidate[] {
  const results:
    ReferenceCandidate[] = [];

  const regex =
    /\b(UTR|XUTR|RRN|REF(?:ERENCE)?(?:\s*(?:NO|NUMBER))?|TXN\s*(?:ID|REF(?:ERENCE)?)|TRANSACTION\s*(?:ID|REF(?:ERENCE)?))\b[\s:/=_-]*([A-Z0-9][A-Z0-9/_-]{5,48})/gi;

  let match:
    RegExpExecArray | null;

  while (
    (
      match =
        regex.exec(
          text,
        )
    ) !== null
  ) {
    const label =
      (
        match[1] ?? ""
      ).toUpperCase();

    let score = 300;

    if (
      label.includes(
        "UTR",
      )
    ) {
      score = 400;
    } else if (
      label === "RRN"
    ) {
      score = 390;
    } else if (
      label.includes(
        "REF",
      )
    ) {
      score = 330;
    }

    addRef(
      results,
      match[2],
      score,
      `explicit ${label}`,
    );
  }

  return results;
}

/**
 * Mode-specific references.
 */
function modeRefCandidates(
  text: string,
  mode: PaymentMode,
): ReferenceCandidate[] {
  const results:
    ReferenceCandidate[] = [];

  const normalized =
    compactText(
      text,
    );

  function collect(
    regex: RegExp,
    score: number,
    source: string,
  ) {
    let match:
      RegExpExecArray | null;

    while (
      (
        match =
          regex.exec(
            normalized,
          )
      ) !== null
    ) {
      addRef(
        results,
        match[1],
        score,
        source,
      );
    }
  }

  if (
    mode === "UPI"
  ) {
    collect(
      /\bUPI\/RRN\/?(\d{12})(?!\d)/gi,
      380,
      "UPI RRN",
    );

    collect(
      /\bUPI\/(?:CR\/|DR\/)?(\d{12})(?!\d)/gi,
      370,
      "UPI narration reference",
    );

    collect(
      /\bMPAY\/UPI\/(?:TRTR\/)?(\d{12})(?!\d)/gi,
      380,
      "MPAY UPI reference",
    );

    collect(
      /\bTRTR\/(\d{12})(?!\d)/gi,
      370,
      "TRTR reference",
    );
  }

  if (
    mode === "IMPS"
  ) {
    collect(
      /\bIMPS\/(?:P2A\/|P2P\/)?(\d{10,18})(?!\d)/gi,
      370,
      "IMPS reference",
    );

    collect(
      /\bPS\/?P2A\/?(\d{10,18})(?!\d)/gi,
      365,
      "IMPS P2A reference",
    );

    collect(
      /\bPSP2A(\d{10,18})(?!\d)/gi,
      365,
      "PSP2A reference",
    );

    collect(
      /\bIMPSP2A(\d{10,18})(?!\d)/gi,
      365,
      "IMPSP2A reference",
    );

    /*
     * IMPS reversal:
     *
     * IMPS_10062026_616117754870_REV_R6162000844
     */
    collect(
      /\bIMPS[_/-]\d{8}[_/-](\d{10,18})(?:[_/-]|$)/gi,
      360,
      "IMPS reversal reference",
    );
  }

  if (
    mode === "NEFT"
  ) {
    collect(
      /\b(?:IBNEFT|ENEFT|NEFT)[/:=_-]+([A-Z0-9][A-Z0-9_-]{7,45})/gi,
      355,
      "NEFT reference",
    );

    /*
     * Formats:
     *
     * MAHBN12026061155411106
     * BARBL26078306964
     * CBINN62026073007915077
     */
    collect(
      /\b([A-Z]{4,8}[A-Z0-9]*\d[A-Z0-9]{8,35})\b/gi,
      300,
      "bank NEFT UTR",
    );
  }

  if (
    mode === "RTGS"
  ) {
    collect(
      /\b(?:IBRTGS|ERTGS|RTGS)[/:=_-]+([A-Z0-9][A-Z0-9_-]{7,45})/gi,
      355,
      "RTGS reference",
    );

    collect(
      /\b([A-Z]{4,8}R[A-Z0-9]{8,35})\b/gi,
      320,
      "bank RTGS UTR",
    );

    collect(
      /\b([A-Z]{4,8}[A-Z0-9]*\d[A-Z0-9]{8,35})\b/gi,
      285,
      "bank transfer reference",
    );
  }

  return results;
}

/**
 * Generic alphanumeric candidates.
 */
function genericRefCandidates(
  text: string,
): ReferenceCandidate[] {
  const results:
    ReferenceCandidate[] = [];

  /*
   * 12-digit candidate.
   */
  const twelve =
    /(?<!\d)(\d{12})(?!\d)/g;

  let match:
    RegExpExecArray | null;

  while (
    (
      match =
        twelve.exec(
          text,
        )
    ) !== null
  ) {
    addRef(
      results,
      match[1],
      170,
      "generic 12-digit candidate",
    );
  }

  /*
   * Bank-style alphanumeric token.
   */
  const alphaNumeric =
    /\b([A-Z]{3,10}[A-Z0-9_-]*\d[A-Z0-9_-]{5,35})\b/gi;

  while (
    (
      match =
        alphaNumeric.exec(
          text,
        )
    ) !== null
  ) {
    addRef(
      results,
      match[1],
      150,
      "generic bank candidate",
    );
  }

  return results;
}

/**
 * Score the dedicated reference column.
 *
 * IMPORTANT:
 *
 * Some banks put a short internal reference like:
 *
 * S7286266
 *
 * while actual NEFT UTR is in narration:
 *
 * CIB203366791-NEFT-...
 *
 * Therefore dedicated reference column is strong, but not always highest.
 */
function dedicatedRefCandidates(
  row: Row,
  columns:
    | ColumnMap
    | null,
): ReferenceCandidate[] {
  if (
    columns?.reference ===
    undefined
  ) {
    return [];
  }

  const raw =
    row[
      columns.reference
    ] ?? "";

  const results =
    explicitRefCandidates(
      raw,
    );

  const cleaned =
    cleanReference(
      raw,
    );

  if (
    usableReference(
      cleaned,
    )
  ) {
    let score = 260;

    /*
     * Short bank/internal ref gets slightly lower score
     * than real long UTR in narration.
     */
    if (
      cleaned.length <= 9
    ) {
      score = 210;
    }

    addRef(
      results,
      cleaned,
      score,
      "dedicated reference column",
    );
  }

  return results;
}

/**
 * Select best reference.
 */
export function extractReference(
  row: Row,
  columns:
    | ColumnMap
    | null,
  mode: PaymentMode,
): string | null {
  const text =
    rowText(
      row,
    );

  const candidates:
    ReferenceCandidate[] = [
      ...dedicatedRefCandidates(
        row,
        columns,
      ),

      ...explicitRefCandidates(
        text,
      ),

      ...modeRefCandidates(
        text,
        mode,
      ),

      ...genericRefCandidates(
        text,
      ),
    ];

  /*
   * Additional UPI behavior:
   *
   * dedicated reference may look like:
   *
   * UPI-535457308010
   *
   * description may contain another 12-digit number.
   *
   * The UPI-prefixed reference column is stronger.
   */
  if (
    mode === "UPI" &&
    columns?.reference !==
      undefined
  ) {
    const referenceCell =
      compactText(
        row[
          columns.reference
        ] ?? "",
      );

    const match =
      /(?:^|[/_-])UPI[-/:]?(\d{12})(?!\d)/i.exec(
        referenceCell,
      );

    if (
      match?.[1]
    ) {
      addRef(
        candidates,
        match[1],
        395,
        "UPI dedicated reference",
      );
    }
  }

  /*
   * Deduplicate.
   */
  const best =
    new Map<
      string,
      ReferenceCandidate
    >();

  for (
    const candidate of
      candidates
  ) {
    const key =
      candidate.value.toUpperCase();

    const previous =
      best.get(key);

    if (
      !previous ||
      candidate.score >
        previous.score
    ) {
      best.set(
        key,
        candidate,
      );
    }
  }

  const ranked =
    [...best.values()]
      .sort(
        (
          a,
          b,
        ) =>
          b.score -
          a.score,
      );

  return (
    ranked[0]?.value ??
    null
  );
}

/* ========================================================================== *
 * NARRATION
 * ========================================================================== */

function getNarration(
  row: Row,
  columns:
    | ColumnMap
    | null,
): string {
  if (
    columns?.narration !==
    undefined
  ) {
    const value =
      normalizeText(
        row[
          columns.narration
        ] ?? "",
      );

    if (value) {
      return value;
    }
  }

  return rowText(
    row,
  );
}

/* ========================================================================== *
 * SUMMARY
 * ========================================================================== */

function parseSummaryNumber(
  match:
    | string
    | undefined,
): number | undefined {
  if (!match) {
    return undefined;
  }

  const number =
    Number(
      match.replace(
        /,/g,
        "",
      ),
    );

  return Number.isFinite(
    number,
  )
    ? number
    : undefined;
}

function findSummary(
  text: string,
  regex: RegExp,
): number | undefined {
  const match =
    regex.exec(
      text,
    );

  return parseSummaryNumber(
    match?.[1],
  );
}

/**
 * Official statement summary is validation evidence.
 *
 * It must never modify transactions just to force totals to match.
 */
export function extractStatementSummary(
  rows: Row[],
): StatementSummary | null {
  const text =
    rows
      .map(
        rowText,
      )
      .join(
        "\n",
      );

  const summary:
    StatementSummary = {
      transactionCount:
        findSummary(
          text,
          /total\s+transaction\s+count\s*[:=-]?\s*(\d+)/i,
        ),

      debitCount:
        findSummary(
          text,
          /total\s+debit\s+count\s*[:=-]?\s*(\d+)/i,
        ),

      creditCount:
        findSummary(
          text,
          /total\s+credit\s+count\s*[:=-]?\s*(\d+)/i,
        ),

      debitAmount:
        findSummary(
          text,
          /total\s+debit\s+amount\s*[:=-]?\s*₹?\s*([\d,]+(?:\.\d{1,2})?)/i,
        ),

      creditAmount:
        findSummary(
          text,
          /total\s+credit\s+amount\s*[:=-]?\s*₹?\s*([\d,]+(?:\.\d{1,2})?)/i,
        ),

      openingBalance:
        findSummary(
          text,
          /opening\s+balance\s*[:=-]?\s*₹?\s*([\d,]+(?:\.\d{1,2})?)/i,
        ),

      closingBalance:
        findSummary(
          text,
          /closing\s+balance\s*[:=-]?\s*₹?\s*([\d,]+(?:\.\d{1,2})?)/i,
        ),
    };

  const hasAnything =
    Object.values(
      summary,
    ).some(
      (
        value,
      ) =>
        value !==
        undefined,
    );

  return hasAnything
    ? summary
    : null;
}

/* ========================================================================== *
 * CONFIDENCE
 * ========================================================================== */

function calculateConfidence(
  transaction: Omit<
    CoreTransaction,
    "confidence"
  >,
): Confidence {
  let score = 0;

  if (
    transaction.date
  ) {
    score += 2;
  }

  if (
    transaction.amount !==
    null
  ) {
    score += 3;
  }

  if (
    transaction.direction !==
    "unknown"
  ) {
    score += 4;
  }

  if (
    transaction.mode !==
    "OTHER"
  ) {
    score += 2;
  }

  if (
    transaction.reference
  ) {
    score += 2;
  }

  if (
    transaction.reasons.some(
      (
        reason,
      ) =>
        /dedicated|explicit|reconciliation/i.test(
          reason,
        ),
    )
  ) {
    score += 2;
  }

  if (
    score >= 11
  ) {
    return "high";
  }

  if (
    score >= 7
  ) {
    return "medium";
  }

  return "low";
}

/* ========================================================================== *
 * MAIN PARSER
 * ========================================================================== */

export function parseStatementRows(
  inputRows: Row[],
  inheritedColumns:
    | ColumnMap
    | null = null,
): CoreResult {
  const warnings:
    string[] = [];

  const found =
    findColumns(
      inputRows,
    );

  /*
   * Multi-sheet statements:
   *
   * sheet 1 may contain header;
   * sheet 2 may directly continue transactions.
   *
   * statement-readers can pass previous columns into this function.
   */
  const columns =
    found.columns ??
    inheritedColumns;

  const startIndex =
    found.headerIndex >= 0
      ? found.headerIndex +
        Math.max(
          1,
          found.headerDepth,
        )
      : 0;

  const rebuilt =
    reconstructRows(
      inputRows,
      startIndex,
    );

  const summary =
    extractStatementSummary(
      inputRows,
    );

  const transactions:
    CoreTransaction[] = [];

  let previousBalance:
    number | null =
    null;

  for (
    let index = 0;
    index <
    rebuilt.length;
    index++
  ) {
    const row =
      rebuilt[index] ??
      [];

    const raw =
      rowText(
        row,
      );

    let rawDate = "";

    if (
      columns?.date !==
      undefined
    ) {
      rawDate =
        normalizeText(
          row[
            columns.date
          ] ?? "",
        );
    }

    const date =
      extractDate(
        rawDate,
      ) ??
      row
        .map(
          (
            cell,
          ) =>
            extractDate(
              cell,
            ),
        )
        .find(
          (
            value,
          ) =>
            Boolean(
              value,
            ),
        ) ??
      extractDate(
        raw,
      );

    if (!date) {
      continue;
    }

    const narration =
      getNarration(
        row,
        columns,
      );

    /*
     * Detect mode from narration first,
     * then whole row as fallback.
     */
    let mode =
      detectMode(
        narration,
      );

    if (
      mode === "OTHER"
    ) {
      mode =
        detectMode(
          raw,
        );
    }

    const classified =
      classifyTransaction(
        row,
        columns,
        narration,
        previousBalance,
      );

    const reference =
      extractReference(
        row,
        columns,
        mode,
      );

    const partial:
      Omit<
        CoreTransaction,
        "confidence"
      > = {
        date,

        rawDate:
          rawDate ||
          date,

        narration,

        reference,

        amount:
          classified.amount,

        direction:
          classified.direction,

        mode,

        balance:
          classified.balance,

        raw,

        rowIndex:
          index,

        reasons:
          classified.reasons,
      };

    transactions.push({
      ...partial,

      confidence:
        calculateConfidence(
          partial,
        ),
    });

    if (
      classified.balance !==
      null
    ) {
      previousBalance =
        classified.balance;
    }
  }

  /* ---------------------------------------------------------------- *
   * VALIDATE AGAINST OFFICIAL SUMMARY
   * ---------------------------------------------------------------- */

  if (summary) {
    const debits =
      transactions.filter(
        (
          transaction,
        ) =>
          transaction.direction ===
            "debit" &&
          transaction.amount !==
            null,
      );

    const credits =
      transactions.filter(
        (
          transaction,
        ) =>
          transaction.direction ===
            "credit" &&
          transaction.amount !==
            null,
      );

    const debitAmount =
      debits.reduce(
        (
          sum,
          transaction,
        ) =>
          sum +
          (
            transaction.amount ??
            0
          ),
        0,
      );

    const creditAmount =
      credits.reduce(
        (
          sum,
          transaction,
        ) =>
          sum +
          (
            transaction.amount ??
            0
          ),
        0,
      );

    if (
      summary.debitCount !==
        undefined &&
      summary.debitCount !==
        debits.length
    ) {
      warnings.push(
        `Debit count mismatch: official=${summary.debitCount}, extracted=${debits.length}`,
      );
    }

    if (
      summary.creditCount !==
        undefined &&
      summary.creditCount !==
        credits.length
    ) {
      warnings.push(
        `Credit count mismatch: official=${summary.creditCount}, extracted=${credits.length}`,
      );
    }

    if (
      summary.debitAmount !==
        undefined &&
      Math.abs(
        summary.debitAmount -
          debitAmount,
      ) > 0.02
    ) {
      warnings.push(
        `Debit amount mismatch: official=${summary.debitAmount.toFixed(
          2,
        )}, extracted=${debitAmount.toFixed(
          2,
        )}`,
      );
    }

    if (
      summary.creditAmount !==
        undefined &&
      Math.abs(
        summary.creditAmount -
          creditAmount,
      ) > 0.02
    ) {
      warnings.push(
        `Credit amount mismatch: official=${summary.creditAmount.toFixed(
          2,
        )}, extracted=${creditAmount.toFixed(
          2,
        )}`,
      );
    }
  }

  return {
    transactions,

    columns,

    summary,

    warnings,
  };
}

/* ========================================================================== *
 * TEXT PARSING
 * ========================================================================== */

/**
 * Do not aggressively split fixed-width statement lines.
 *
 * Preserve each physical line first.
 * Reconstruction will join wrapped lines.
 */
export function textToRows(
  input: string,
): Row[] {
  return String(
    input ?? "",
  )
    .replace(
      /\r\n?/g,
      "\n",
    )
    .split(
      "\n",
    )
    .map(
      (
        line,
      ) => {
        /*
         * OCR normalization format:
         *
         * Date | Narration | Ref | Debit | Credit | Balance
         */
        if (
          (
            line.match(
              /\|/g,
            ) ?? []
          ).length >= 4
        ) {
          return line
            .split(
              "|",
            )
            .map(
              (
                part,
              ) =>
                normalizeText(
                  part,
                ),
            );
        }

        /*
         * Tab-delimited text.
         */
        if (
          line.includes(
            "\t",
          )
        ) {
          return line
            .split(
              "\t",
            )
            .map(
              (
                part,
              ) =>
                normalizeText(
                  part,
                ),
            );
        }

        return [
          normalizeText(
            line,
          ),
        ];
      },
    )
    .filter(
      (
        row,
      ) =>
        row.some(
          Boolean,
        ),
    );
}

export function parseStatementText(
  text: string,
): CoreResult {
  return parseStatementRows(
    textToRows(
      text,
    ),
  );
}

/* ========================================================================== *
 * RESULT MERGE / DEDUPE
 * ========================================================================== */

function transactionKey(
  transaction:
    CoreTransaction,
): string {
  return [
    transaction.date,

    transaction.direction,

    transaction.mode,

    transaction.reference ??
      "",

    transaction.amount ===
    null
      ? ""
      : transaction.amount.toFixed(
          2,
        ),
  ]
    .join(
      "|",
    )
    .toUpperCase();
}

function transactionQuality(
  transaction:
    CoreTransaction,
): number {
  let score = 0;

  if (
    transaction.reference
  ) {
    score += 5;
  }

  if (
    transaction.amount !==
    null
  ) {
    score += 5;
  }

  if (
    transaction.direction !==
    "unknown"
  ) {
    score += 5;
  }

  if (
    transaction.mode !==
    "OTHER"
  ) {
    score += 3;
  }

  if (
    transaction.balance !==
    null
  ) {
    score += 2;
  }

  if (
    transaction.confidence ===
    "high"
  ) {
    score += 3;
  } else if (
    transaction.confidence ===
    "medium"
  ) {
    score += 1;
  }

  return score;
}

/**
 * Used when:
 *
 * - PDF native parse + OCR parse
 * - multiple sheets
 * - multiple files
 */
export function mergeCoreResults(
  results:
    CoreResult[],
): CoreResult {
  const map =
    new Map<
      string,
      CoreTransaction
    >();

  const warnings =
    new Set<string>();

  let columns:
    ColumnMap | null =
    null;

  let summary:
    StatementSummary | null =
    null;

  for (
    const result of
      results
  ) {
    columns ??=
      result.columns;

    summary ??=
      result.summary;

    for (
      const warning of
        result.warnings
    ) {
      warnings.add(
        warning,
      );
    }

    for (
      const transaction of
        result.transactions
    ) {
      const key =
        transactionKey(
          transaction,
        );

      const old =
        map.get(
          key,
        );

      if (
        !old ||
        transactionQuality(
          transaction,
        ) >
          transactionQuality(
            old,
          )
      ) {
        map.set(
          key,
          transaction,
        );
      }
    }
  }

  return {
    transactions:
      [
        ...map.values(),
      ],

    columns,

    summary,

    warnings:
      [
        ...warnings,
      ],
  };
}

/* ========================================================================== *
 * FILTER HELPERS
 * ========================================================================== */

/**
 * Credit requirement:
 * only UPI credit.
 */
export function isUpiCredit(
  transaction:
    CoreTransaction,
): boolean {
  return (
    transaction.direction ===
      "credit" &&
    transaction.mode ===
      "UPI" &&
    transaction.amount !==
      null
  );
}

/**
 * Every actual debit.
 *
 * Includes OTHER:
 * charges / cash / self / internal / StCon etc.
 */
export function isAnyDebit(
  transaction:
    CoreTransaction,
): boolean {
  return (
    transaction.direction ===
      "debit" &&
    transaction.amount !==
      null
  );
}

/**
 * Requested payment-network debit.
 */
export function isPaymentDebit(
  transaction:
    CoreTransaction,
): boolean {
  return (
    isAnyDebit(
      transaction,
    ) &&
    (
      transaction.mode ===
        "UPI" ||
      transaction.mode ===
        "IMPS" ||
      transaction.mode ===
        "NEFT" ||
      transaction.mode ===
        "RTGS"
    )
  );
}

/**
 * Useful for UI:
 *
 * payment debit vs other debit.
 */
export function isOtherDebit(
  transaction:
    CoreTransaction,
): boolean {
  return (
    isAnyDebit(
      transaction,
    ) &&
    transaction.mode ===
      "OTHER"
  );
}

export function formatAmount(
  value: number,
): string {
  return Math.abs(
    value,
  ).toFixed(
    2,
  );
}
