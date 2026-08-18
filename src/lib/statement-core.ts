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
        text.length > 120
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
       * IMPORTANT:
       * "Balance Dr/Cr" belongs to BALANCE,
       * not transaction direction.
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
       * Combined Debit/Credit indicator column.
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
     * Support two-row spreadsheet headers.
     */
    if (
      rows[index + 1]
    ) {
      const second =
        rows[index + 1] ?? [];

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
              first[column] ?? ""
            } ${
              second[column] ?? ""
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
        score > best.score
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
 * Expected OCR normalized output:
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
 * Reconstruct transactions whose narration/reference
 * continues on following physical rows.
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
    index < rows.length;
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
     * Ignore repeated headers between PDF pages.
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
     * Wrapped continuation line.
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
            current[column] ?? ""
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
