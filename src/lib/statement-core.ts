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

  /*
   * Approx 2000-2100.
   */
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
        date.getUTCMonth() +
          1,
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
      match[3] ?? "",
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
      match[1] ?? "",
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
    Number(
      parts[0],
    );

  const month =
    Number(
      parts[1],
    );

  const year =
    Number(
      parts[2],
    );

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

  /*
   * Avoid parsing dates as money.
   */
  if (
    /[-/.]/.test(
      original,
    ) &&
    extractDate(
      original,
    ) !== null
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
      -Math.abs(
        value,
      );
  }

  return value;
}

/**
 * Extract money-like values from a full text row.
 *
 * Dates and long reference numbers are removed first.
 */
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

  /*
   * Remove pure long references.
   */
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
      values[0] ??
      null,

    second:
      values[1] ??
      null,
  };
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
  /\b(debit\s*\/\s*credit|credit\s*\/\s*debit|dr\s*\/\s*cr|cr\s*\/\s*dr|transaction\s*type|txn\s*type|indicator)\b/i;

const BALANCE_HEADER =
  /\b(closing\s*balance|running\s*balance|available\s*balance|balance\s*\(inr\)|balance)\b/i;

const AMOUNT_HEADER =
  /\b(transaction\s*amount|txn\s*amount|amount\s*\(inr\)|amount)\b/i;

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
        text.length >
          120
      ) {
        return;
      }

      if (
        SERIAL_HEADER.test(
          text,
        )
      ) {
        if (
          map.serial ===
          undefined
        ) {
          map.serial =
            index;
        }

        return;
      }

      if (
        VALUE_DATE_HEADER.test(
          text,
        )
      ) {
        if (
          map.valueDate ===
          undefined
        ) {
          map.valueDate =
            index;

          evidence++;
        }

        return;
      }

      if (
        DATE_HEADER.test(
          text,
        )
      ) {
        if (
          map.date ===
          undefined
        ) {
          map.date =
            index;

          evidence++;
        }

        return;
      }

      if (
        NARRATION_HEADER.test(
          text,
        )
      ) {
        if (
          map.narration ===
          undefined
        ) {
          map.narration =
            index;

          evidence++;
        }

        return;
      }

      if (
        REFERENCE_HEADER.test(
          text,
        )
      ) {
        if (
          map.reference ===
          undefined
        ) {
          map.reference =
            index;

          evidence++;
        }

        return;
      }

      /*
       * Balance + Dr/Cr = BALANCE TYPE,
       * not transaction type.
       */
      if (
        BALANCE_HEADER.test(
          text,
        ) &&
        /\b(?:dr|cr)\b/i.test(
          text,
        )
      ) {
        if (
          map.balanceType ===
          undefined
        ) {
          map.balanceType =
            index;
        }

        return;
      }

      if (
        BALANCE_HEADER.test(
          text,
        )
      ) {
        if (
          map.balance ===
          undefined
        ) {
          map.balance =
            index;

          evidence++;
        }

        return;
      }

      if (
        CHANNEL_HEADER.test(
          text,
        )
      ) {
        if (
          map.channel ===
          undefined
        ) {
          map.channel =
            index;
        }

        return;
      }

      /*
       * Combined Debit/Credit column.
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
        if (
          map.type ===
          undefined
        ) {
          map.type =
            index;

          evidence++;
        }

        return;
      }

      if (
        DEBIT_HEADER.test(
          text,
        )
      ) {
        if (
          map.debit ===
          undefined
        ) {
          map.debit =
            index;

          evidence++;
        }

        return;
      }

      if (
        CREDIT_HEADER.test(
          text,
        )
      ) {
        if (
          map.credit ===
          undefined
        ) {
          map.credit =
            index;

          evidence++;
        }

        return;
      }

      if (
        AMOUNT_HEADER.test(
          text,
        )
      ) {
        if (
          map.amount ===
          undefined
        ) {
          map.amount =
            index;

          evidence++;
        }
      }
    },
  );

  return evidence >= 2
    ? map
    : null;
}

function columnScore(
  map: ColumnMap,
): number {
  let score = 0;

  if (
    map.date !==
    undefined
  ) {
    score += 5;
  }

  if (
    map.narration !==
    undefined
  ) {
    score += 5;
  }

  if (
    map.debit !==
    undefined
  ) {
    score += 5;
  }

  if (
    map.credit !==
    undefined
  ) {
    score += 5;
  }

  if (
    map.amount !==
    undefined
  ) {
    score += 4;
  }

  if (
    map.type !==
    undefined
  ) {
    score += 4;
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
    {
      columns: ColumnMap;
      headerIndex: number;
      headerDepth: number;
      score: number;
    } | null =
    null;

  for (
    let index = 0;
    index < maxRows;
    index++
  ) {
    const first =
      rows[index] ?? [];

    const candidates:
      Array<{
        row: Row;
        depth: number;
      }> = [
        {
          row: first,
          depth: 1,
        },
      ];

    /*
     * Two-row headers.
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
        let column = 0;
        column < width;
        column++
      ) {
        combined[column] =
          normalizeText(
            `${
              first[
                column
              ] ?? ""
            } ${
              second[
                column
              ] ?? ""
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
      const columns =
        detectColumns(
          candidate.row,
        );

      if (!columns) {
        continue;
      }

      const score =
        columnScore(
          columns,
        );

      if (
        !best ||
        score >
          best.score
      ) {
        best = {
          columns,
          headerIndex:
            index,
          headerDepth:
            candidate.depth,
          score,
        };
      }
    }
  }

  if (!best) {
    return {
      columns: null,
      headerIndex: -1,
      headerDepth: 0,
    };
  }

  return {
    columns:
      best.columns,

    headerIndex:
      best.headerIndex,

    headerDepth:
      best.headerDepth,
  };
}

/* ========================================================================== *
 * IMPLICIT OCR COLUMN DETECTION
 * ========================================================================== */

/**
 * OCR server outputs:
 *
 * Date | Narration | Reference | Debit | Credit | Balance
 */
function inferOcrColumns(
  rows: Row[],
): ColumnMap | null {
  const samples =
    rows.filter(
      (
        row,
      ) =>
        row.length >= 6 &&
        extractDate(
          row[0] ?? "",
        ) !== null,
    );

  if (
    samples.length < 1
  ) {
    return null;
  }

  const enough =
    samples.slice(
      0,
      10,
    );

  let moneyRows = 0;

  for (
    const row of enough
  ) {
    const debit =
      parseMoney(
        row[3] ?? "",
      );

    const credit =
      parseMoney(
        row[4] ?? "",
      );

    const balance =
      parseMoney(
        row[5] ?? "",
      );

    if (
      debit !== null ||
      credit !== null ||
      balance !== null
    ) {
      moneyRows++;
    }
  }

  if (
    moneyRows === 0
  ) {
    return null;
  }

  return {
    date: 0,
    narration: 1,
    reference: 2,
    debit: 3,
    credit: 4,
    balance: 5,
  };
}

/* ========================================================================== *
 * TRANSACTION ROW RECONSTRUCTION
 * ========================================================================== */

function hasDate(
  row: Row,
): boolean {
  return row.some(
    (
      cell,
    ) =>
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

function isStandaloneNoise(
  row: Row,
): boolean {
  const text =
    rowText(
      row,
    );

  if (!text) {
    return true;
  }

  if (
    hasDate(
      row,
    )
  ) {
    return false;
  }

  return (
    /\b(account\s*(?:no|number)|customer\s*(?:id|name|number)|branch\s*(?:name|code|address)|ifsc|micr|statement\s*(?:of\s*account)?|nominee|currency|registered\s*mobile|registered\s*email)\b/i.test(
      text,
    ) ||
    /^page\s+\d+(?:\s+of\s+\d+)?$/i.test(
      text,
    ) ||
    /^total\s+(?:debit|credit|transaction)/i.test(
      text,
    ) ||
    /^opening\s+balance/i.test(
      text,
    ) ||
    /^closing\s+balance/i.test(
      text,
    )
  );
}

/**
 * Join wrapped rows.
 */
export function reconstructRows(
  rows: Row[],
  startIndex = 0,
): Row[] {
  const output:
    Row[] = [];

  let current:
    Row | null =
    null;

  for (
    let index =
      Math.max(
        0,
        startIndex,
      );
    index <
    rows.length;
    index++
  ) {
    const source =
      rows[index] ?? [];

    const row =
      source.map(
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
     * Repeated page table header.
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
      isStandaloneNoise(
        row,
      )
    ) {
      continue;
    }

    if (
      hasDate(
        row,
      )
    ) {
      if (current) {
        output.push(
          current,
        );
      }

      current =
        [...row];

      continue;
    }

    if (!current) {
      continue;
    }

    /*
     * Wrapped continuation row.
     */
    const width =
      Math.max(
        current.length,
        row.length,
      );

    for (
      let column = 0;
      column < width;
      column++
    ) {
      const extra =
        row[column] ?? "";

      if (!extra) {
        continue;
      }

      current[column] =
        normalizeText(
          `${
            current[
              column
            ] ?? ""
          } ${extra}`,
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
 * STATEMENT ORDER
 * ========================================================================== */

/**
 * Detect ascending vs descending transaction date order.
 *
 * Same-date rows are ignored.
 */
function detectStatementOrder(
  rows: Row[],
  columns:
    ColumnMap | null,
): StatementOrder {
  const dates:
    number[] = [];

  for (
    const row of rows
  ) {
    const dateText =
      columns?.date !==
      undefined
        ? row[
            columns.date
          ] ?? ""
        : rowText(
            row,
          );

    const value =
      dateNumber(
        dateText,
      );

    if (
      value !== null
    ) {
      dates.push(
        value,
      );
    }
  }

  for (
    let index = 1;
    index < dates.length;
    index++
  ) {
    const previous =
      dates[
        index - 1
      ];

    const current =
      dates[index];

    if (
      previous ===
        undefined ||
      current ===
        undefined ||
      previous ===
        current
    ) {
      continue;
    }

    return current >
      previous
      ? "ascending"
      : "descending";
  }

  return "unknown";
}

/* ========================================================================== *
 * DIRECTION INDICATORS
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
    /\b(?:credited|amount credited|credit received|amount received)\b/i.test(
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
 * MODE
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
 * REFERENCE / UTR
 * ========================================================================== */

type ReferenceCandidate = {
  value: string;
  score: number;
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

function looksLikeMobile(
  value: string,
): boolean {
  return /^[6-9]\d{9}$/.test(
    value,
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

  const compact =
    value.replace(
      /[-_/]/g,
      "",
    );

  if (
    compact.length < 6 ||
    compact.length > 50
  ) {
    return false;
  }

  if (
    !/\d/.test(
      compact,
    )
  ) {
    return false;
  }

  if (
    looksLikeIfsc(
      value,
    ) ||
    looksLikeMobile(
      value,
    ) ||
    extractDate(
      value,
    ) !== null ||
    looksLikeMoneyValue(
      value,
    )
  ) {
    return false;
  }

  return true;
}

function addReference(
  target:
    ReferenceCandidate[],
  input:
    string | undefined,
  score: number,
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

  target.push({
    value,
    score,
  });
}

function explicitReferenceCandidates(
  text: string,
): ReferenceCandidate[] {
  const output:
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

    let score = 330;

    if (
      label.includes(
        "UTR",
      )
    ) {
      score = 450;
    } else if (
      label === "RRN"
    ) {
      score = 440;
    }

    addReference(
      output,
      match[2],
      score,
    );
  }

  return output;
}

function modeReferenceCandidates(
  text: string,
  mode: PaymentMode,
): ReferenceCandidate[] {
  const output:
    ReferenceCandidate[] = [];

  const normalized =
    compactText(
      text,
    );

  const collect =
    (
      regex: RegExp,
      score: number,
    ) => {
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
        addReference(
          output,
          match[1],
          score,
        );
      }
    };

  if (
    mode === "UPI"
  ) {
    collect(
      /\bUPI\/RRN\/?(\d{12})(?!\d)/gi,
      430,
    );

    collect(
      /\bUPI\/(?:CR\/|DR\/)?(\d{12})(?!\d)/gi,
      420,
    );

    collect(
      /\bMPAY\/UPI\/(?:TRTR\/)?(\d{12})(?!\d)/gi,
      430,
    );

    collect(
      /\bTRTR\/(\d{12})(?!\d)/gi,
      420,
    );
  }

  if (
    mode === "IMPS"
  ) {
    collect(
      /\bIMPS\/(?:P2A\/|P2P\/)?(\d{10,18})(?!\d)/gi,
      420,
    );

    collect(
      /\bPS\/?P2A\/?(\d{10,18})(?!\d)/gi,
      410,
    );

    collect(
      /\bPSP2A(\d{10,18})(?!\d)/gi,
      410,
    );

    collect(
      /\bIMPSP2A(\d{10,18})(?!\d)/gi,
      410,
    );

    collect(
      /\bIMPS[_/-]\d{8}[_/-](\d{10,18})(?:[_/-]|$)/gi,
      400,
    );
  }

  if (
    mode === "NEFT"
  ) {
    /*
     * Do NOT capture beneficiary words after '-'.
     */
    collect(
      /\b(?:IBNEFT|ENEFT|NEFT)[/:=_-]+([A-Z0-9]{8,40})(?=$|[-/:\s])/gi,
      410,
    );

    collect(
      /\b([A-Z]{4,8}[A-Z0-9]*\d[A-Z0-9]{8,32})\b/gi,
      340,
    );
  }

  if (
    mode === "RTGS"
  ) {
    collect(
      /\b(?:IBRTGS|ERTGS|RTGS)[/:=_-]+([A-Z0-9]{8,40})(?=$|[-/:\s])/gi,
      410,
    );

    collect(
      /\b([A-Z]{4,8}R[A-Z0-9]{8,32})\b/gi,
      360,
    );

    collect(
      /\b([A-Z]{4,8}[A-Z0-9]*\d[A-Z0-9]{8,32})\b/gi,
      330,
    );
  }

  return output;
}

function genericReferenceCandidates(
  text: string,
): ReferenceCandidate[] {
  const output:
    ReferenceCandidate[] = [];

  let match:
    RegExpExecArray | null;

  const twelve =
    /(?<!\d)(\d{12})(?!\d)/g;

  while (
    (
      match =
        twelve.exec(
          text,
        )
    ) !== null
  ) {
    addReference(
      output,
      match[1],
      180,
    );
  }

  const bankToken =
    /\b([A-Z]{3,10}[A-Z0-9_-]*\d[A-Z0-9_-]{5,32})\b/gi;

  while (
    (
      match =
        bankToken.exec(
          text,
        )
    ) !== null
  ) {
    addReference(
      output,
      match[1],
      160,
    );
  }

  return output;
}

export function extractReference(
  row: Row,
  columns:
    ColumnMap | null,
  mode: PaymentMode,
): string | null {
  const candidates:
    ReferenceCandidate[] = [];

  /*
   * Dedicated reference column.
   */
  if (
    columns?.reference !==
    undefined
  ) {
    const cell =
      normalizeText(
        row[
          columns.reference
        ] ?? "",
      );

    candidates.push(
      ...explicitReferenceCandidates(
        cell,
      ),
    );

    /*
     * UPI-535457308010
     */
    if (
      mode === "UPI"
    ) {
      const upi =
        /(?:^|[/_-])UPI[-/:]?(\d{12})(?!\d)/i.exec(
          compactText(
            cell,
          ),
        );

      if (
        upi?.[1]
      ) {
        addReference(
          candidates,
          upi[1],
          445,
        );
      }
    }

    const cleaned =
      cleanReference(
        cell,
      );

    if (
      usableReference(
        cleaned,
      )
    ) {
      addReference(
        candidates,
        cleaned,
        cleaned.length <=
          9
          ? 205
          : 290,
      );
    }
  }

  const text =
    rowText(
      row,
    );

  candidates.push(
    ...explicitReferenceCandidates(
      text,
    ),
  );

  candidates.push(
    ...modeReferenceCandidates(
      text,
      mode,
    ),
  );

  candidates.push(
    ...genericReferenceCandidates(
      text,
    ),
  );

  const best =
    new Map<
      string,
      number
    >();

  for (
    const candidate of
      candidates
  ) {
    const key =
      candidate.value.toUpperCase();

    const previous =
      best.get(
        key,
      );

    if (
      previous ===
        undefined ||
      candidate.score >
        previous
    ) {
      best.set(
        key,
        candidate.score,
      );
    }
  }

  const sorted =
    [...best.entries()]
      .sort(
        (
          a,
          b,
        ) =>
          b[1] -
          a[1],
      );

  return (
    sorted[0]?.[0] ??
    null
  );
}

/* ========================================================================== *
 * ROW FACTS
 * ========================================================================== */

type RowFacts = {
  row: Row;
  rowIndex: number;
  raw: string;
  date: string;
  rawDate: string;
  narration: string;
  mode: PaymentMode;
  reference: string | null;
  balance: number | null;
  flatAmount: number | null;
};

function getNarration(
  row: Row,
  columns:
    ColumnMap | null,
): string {
  if (
    columns?.narration !==
    undefined
  ) {
    const narration =
      normalizeText(
        row[
          columns.narration
        ] ?? "",
      );

    if (
      narration
    ) {
      return narration;
    }
  }

  return rowText(
    row,
  );
}

function parseCell(
  row: Row,
  index:
    number | undefined,
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
 * Current row balance.
 */
function extractBalance(
  row: Row,
  columns:
    ColumnMap | null,
): number | null {
  if (
    columns?.balance !==
    undefined
  ) {
    const direct =
      parseCell(
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
   * Malformed amount+balance same cell.
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
        row[index] ?? "",
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

  /*
   * Flattened PDF/TXT:
   *
   * Date Narration Amount Balance
   */
  if (
    row.length === 1
  ) {
    const values =
      extractMoneyTokens(
        row[0] ?? "",
      );

    if (
      values.length >= 2
    ) {
      return Math.abs(
        values[
          values.length -
            1
        ] ?? 0,
      );
    }
  }

  return null;
}

/**
 * Flattened row transaction amount.
 *
 * Last numeric value = running balance.
 * Previous numeric value = transaction amount.
 */
function extractFlatAmount(
  row: Row,
): number | null {
  if (
    row.length !== 1
  ) {
    return null;
  }

  const values =
    extractMoneyTokens(
      row[0] ?? "",
    );

  if (
    values.length >= 2
  ) {
    return (
      values[
        values.length -
          2
      ] ?? null
    );
  }

  return (
    values[0] ??
    null
  );
}

/* ========================================================================== *
 * DIRECTION + AMOUNT
 * ========================================================================== */

type Classification = {
  direction: Direction;
  amount: number | null;
  reasons: string[];
};

function structuredAmountFallback(
  row: Row,
  columns:
    ColumnMap | null,
): number | null {
  const direct =
    parseCell(
      row,
      columns?.amount,
    );

  if (
    direct !== null
  ) {
    return direct;
  }

  const candidates:
    number[] = [];

  row.forEach(
    (
      cell,
      index,
    ) => {
      if (
        index ===
          columns?.date ||
        index ===
          columns?.valueDate ||
        index ===
          columns?.reference ||
        index ===
          columns?.balance ||
        index ===
          columns?.balanceType ||
        index ===
          columns?.serial ||
        index ===
          columns?.type
      ) {
        return;
      }

      const value =
        parseMoney(
          cell,
        );

      if (
        value !== null
      ) {
        candidates.push(
          value,
        );
      }
    },
  );

  return (
    candidates[0] ??
    null
  );
}

/**
 * `comparisonBalance` is:
 *
 * ascending statement:
 *   previous transaction balance
 *
 * descending statement:
 *   next transaction balance
 *
 * Therefore:
 *
 * currentBalance - comparisonBalance
 *
 * always represents THIS transaction's balance effect.
 */
function classifyFacts(
  facts: RowFacts,
  columns:
    ColumnMap | null,
  comparisonBalance:
    number | null,
): Classification {
  const row =
    facts.row;

  const reasons:
    string[] = [];

  /* ---------------------------------------------------------------- *
   * 1. Dedicated Debit / Credit columns
   * ---------------------------------------------------------------- */

  if (
    columns?.debit !==
      undefined ||
    columns?.credit !==
      undefined
  ) {
    const debit =
      columns.debit !==
      undefined
        ? parseCompoundMoneyCell(
            row[
              columns.debit
            ] ?? "",
          ).first
        : null;

    const credit =
      columns.credit !==
      undefined
        ? parseCompoundMoneyCell(
            row[
              columns.credit
            ] ?? "",
          ).first
        : null;

    if (
      debit !== null &&
      Math.abs(
        debit,
      ) > 0 &&
      (
        credit === null ||
        Math.abs(
          credit,
        ) === 0
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

        reasons,
      };
    }

    if (
      credit !== null &&
      Math.abs(
        credit,
      ) > 0 &&
      (
        debit === null ||
        Math.abs(
          debit,
        ) === 0
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

        reasons,
      };
    }
  }

  /* ---------------------------------------------------------------- *
   * 2. Explicit transaction DR/CR
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
      const amount =
        structuredAmountFallback(
          row,
          columns,
        );

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

          reasons,
        };
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * 3. Negative amount
   * ---------------------------------------------------------------- */

  let amount =
    structuredAmountFallback(
      row,
      columns,
    );

  if (
    amount === null
  ) {
    amount =
      facts.flatAmount;
  }

  if (
    amount !== null &&
    amount < 0
  ) {
    reasons.push(
      "negative transaction amount",
    );

    return {
      direction:
        "debit",

      amount:
        Math.abs(
          amount,
        ),

      reasons,
    };
  }

  /* ---------------------------------------------------------------- *
   * 4. Balance reconciliation
   * ---------------------------------------------------------------- */

  if (
    amount !== null &&
    facts.balance !==
      null &&
    comparisonBalance !==
      null
  ) {
    const delta =
      Number(
        (
          facts.balance -
          comparisonBalance
        ).toFixed(
          2,
        ),
      );

    const difference =
      Math.abs(
        Math.abs(
          delta,
        ) -
          Math.abs(
            amount,
          ),
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
      Math.abs(
        delta,
      ) > 0 &&
      difference <=
        tolerance
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

        reasons,
      };
    }
  }

  /* ---------------------------------------------------------------- *
   * 5. Strong narration marker
   * ---------------------------------------------------------------- */

  const narrationSignal =
    narrationDirection(
      facts.narration,
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

    reasons,
  };
}

/* ========================================================================== *
 * SUMMARY
 * ========================================================================== */

function summaryNumber(
  text: string,
  regex: RegExp,
): number | undefined {
  const match =
    regex.exec(
      text,
    );

  const raw =
    match?.[1];

  if (!raw) {
    return undefined;
  }

  const value =
    Number(
      raw.replace(
        /,/g,
        "",
      ),
    );

  return Number.isFinite(
    value,
  )
    ? value
    : undefined;
}

/**
 * exactOptionalPropertyTypes-safe summary builder.
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
    StatementSummary = {};

  const transactionCount =
    summaryNumber(
      text,
      /total\s+transaction\s+count\s*[:=-]?\s*(\d+)/i,
    );

  if (
    transactionCount !==
    undefined
  ) {
    summary.transactionCount =
      transactionCount;
  }

  const debitCount =
    summaryNumber(
      text,
      /total\s+debit\s+count\s*[:=-]?\s*(\d+)/i,
    );

  if (
    debitCount !==
    undefined
  ) {
    summary.debitCount =
      debitCount;
  }

  const creditCount =
    summaryNumber(
      text,
      /total\s+credit\s+count\s*[:=-]?\s*(\d+)/i,
    );

  if (
    creditCount !==
    undefined
  ) {
    summary.creditCount =
      creditCount;
  }

  const debitAmount =
    summaryNumber(
      text,
      /total\s+debit\s+amount\s*[:=-]?\s*₹?\s*([\d,]+(?:\.\d{1,2})?)/i,
    );

  if (
    debitAmount !==
    undefined
  ) {
    summary.debitAmount =
      debitAmount;
  }

  const creditAmount =
    summaryNumber(
      text,
      /total\s+credit\s+amount\s*[:=-]?\s*₹?\s*([\d,]+(?:\.\d{1,2})?)/i,
    );

  if (
    creditAmount !==
    undefined
  ) {
    summary.creditAmount =
      creditAmount;
  }

  const openingBalance =
    summaryNumber(
      text,
      /opening\s+balance\s*[:=-]?\s*₹?\s*([\d,]+(?:\.\d{1,2})?)/i,
    );

  if (
    openingBalance !==
    undefined
  ) {
    summary.openingBalance =
      openingBalance;
  }

  const closingBalance =
    summaryNumber(
      text,
      /closing\s+balance\s*[:=-]?\s*₹?\s*([\d,]+(?:\.\d{1,2})?)/i,
    );

  if (
    closingBalance !==
    undefined
  ) {
    summary.closingBalance =
      closingBalance;
  }

  return Object.keys(
    summary,
  ).length
    ? summary
    : null;
}

/* ========================================================================== *
 * CONFIDENCE
 * ========================================================================== */

function confidenceFor(
  input: {
    date: string;
    amount: number | null;
    direction: Direction;
    mode: PaymentMode;
    reference: string | null;
    reasons: string[];
  },
): Confidence {
  let score = 0;

  if (
    input.date
  ) {
    score += 2;
  }

  if (
    input.amount !== null
  ) {
    score += 3;
  }

  if (
    input.direction !==
    "unknown"
  ) {
    score += 4;
  }

  if (
    input.mode !==
    "OTHER"
  ) {
    score += 2;
  }

  if (
    input.reference
  ) {
    score += 2;
  }

  if (
    input.reasons.some(
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
    ColumnMap | null =
    null,
): CoreResult {
  const warnings:
    string[] = [];

  const found =
    findColumns(
      inputRows,
    );

  const inferred =
    found.columns ??
    inferOcrColumns(
      inputRows,
    ) ??
    inheritedColumns;

  const columns =
    inferred;

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

  const order =
    detectStatementOrder(
      rebuilt,
      columns,
    );

  const facts:
    RowFacts[] = [];

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
          ): value is string =>
            value !== null,
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

    const reference =
      extractReference(
        row,
        columns,
        mode,
      );

    const balance =
      extractBalance(
        row,
        columns,
      );

    facts.push({
      row,
      rowIndex:
        index,
      raw,
      date,
      rawDate:
        rawDate ||
        date,
      narration,
      mode,
      reference,
      balance,
      flatAmount:
        extractFlatAmount(
          row,
        ),
    });
  }

  const transactions:
    CoreTransaction[] = [];

  for (
    let index = 0;
    index <
    facts.length;
    index++
  ) {
    const factsRow =
      facts[index];

    if (!factsRow) {
      continue;
    }

    /*
     * Ascending:
     * previous balance is before this transaction.
     *
     * Descending:
     * next balance is before this transaction.
     */
    let comparisonBalance:
      number | null =
      null;

    if (
      order ===
      "ascending"
    ) {
      comparisonBalance =
        facts[
          index - 1
        ]?.balance ??
        null;
    } else if (
      order ===
      "descending"
    ) {
      comparisonBalance =
        facts[
          index + 1
        ]?.balance ??
        null;
    }

    const classified =
      classifyFacts(
        factsRow,
        columns,
        comparisonBalance,
      );

    const confidence =
      confidenceFor({
        date:
          factsRow.date,
        amount:
          classified.amount,
        direction:
          classified.direction,
        mode:
          factsRow.mode,
        reference:
          factsRow.reference,
        reasons:
          classified.reasons,
      });

    transactions.push({
      date:
        factsRow.date,

      rawDate:
        factsRow.rawDate,

      narration:
        factsRow.narration,

      reference:
        factsRow.reference,

      amount:
        classified.amount,

      direction:
        classified.direction,

      mode:
        factsRow.mode,

      balance:
        factsRow.balance,

      confidence,

      raw:
        factsRow.raw,

      rowIndex:
        factsRow.rowIndex,

      reasons:
        classified.reasons,
    });
  }

  const summary =
    extractStatementSummary(
      inputRows,
    );

  /*
   * Validation only.
   * Never modify transactions merely to force summary match.
   */
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

    const debitTotal =
      debits.reduce(
        (
          total,
          transaction,
        ) =>
          total +
          (
            transaction.amount ??
            0
          ),
        0,
      );

    const creditTotal =
      credits.reduce(
        (
          total,
          transaction,
        ) =>
          total +
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
          debitTotal,
      ) > 0.02
    ) {
      warnings.push(
        `Debit amount mismatch: official=${summary.debitAmount.toFixed(
          2,
        )}, extracted=${debitTotal.toFixed(
          2,
        )}`,
      );
    }

    if (
      summary.creditAmount !==
        undefined &&
      Math.abs(
        summary.creditAmount -
          creditTotal,
      ) > 0.02
    ) {
      warnings.push(
        `Credit amount mismatch: official=${summary.creditAmount.toFixed(
          2,
        )}, extracted=${creditTotal.toFixed(
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
 * TEXT -> ROWS
 * ========================================================================== */

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
        raw,
      ) => {
        const line =
          raw.trim();

        if (!line) {
          return [];
        }

        /*
         * OCR structured format.
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
         * Tab-delimited TXT.
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

        /*
         * Fixed-width text exported from bank.
         *
         * Keep meaningful columns when there are
         * 2+ spaces between fields.
         */
        const fixed =
          line
            .split(
              /\s{2,}/,
            )
            .map(
              (
                part,
              ) =>
                normalizeText(
                  part,
                ),
            )
            .filter(
              Boolean,
            );

        if (
          fixed.length >= 3
        ) {
          return fixed;
        }

        /*
         * Flattened native PDF line.
         */
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
 * MERGE / DEDUPE
 * ========================================================================== */

function transactionKey(
  transaction:
    CoreTransaction,
): string {
  if (
    transaction.reference
  ) {
    return [
      "REF",
      transaction.reference,
      transaction.direction,
      transaction.mode,
      transaction.amount ===
        null
        ? ""
        : transaction.amount.toFixed(
            2,
          ),
    ]
      .join("|")
      .toUpperCase();
  }

  return [
    "NOREF",
    transaction.date,
    transaction.direction,
    transaction.mode,
    transaction.amount ===
      null
      ? ""
      : transaction.amount.toFixed(
          2,
        ),
    transaction.raw.slice(
      0,
      80,
    ),
  ]
    .join("|")
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

export function mergeCoreResults(
  results:
    CoreResult[],
): CoreResult {
  const map =
    new Map<
      string,
      CoreTransaction
    >();

  const warningSet =
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
    if (
      columns ===
        null &&
      result.columns !==
        null
    ) {
      columns =
        result.columns;
    }

    if (
      summary ===
        null &&
      result.summary !==
        null
    ) {
      summary =
        result.summary;
    }

    for (
      const warning of
        result.warnings
    ) {
      warningSet.add(
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

      const existing =
        map.get(
          key,
        );

      if (
        !existing ||
        transactionQuality(
          transaction,
        ) >
          transactionQuality(
            existing,
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
      [...map.values()],

    columns,

    summary,

    warnings:
      [...warningSet],
  };
}

/* ========================================================================== *
 * FILTER HELPERS
 * ========================================================================== */

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
}n la p
