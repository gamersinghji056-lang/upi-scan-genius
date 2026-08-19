import {
  ocrStatementPages,
} from "./ocr.functions";

import {
  type ExtractDebug,
  type ExtractResult,
  type RowDiagnostic,
  type UpiCredit,
} from "./upi-parser";

import {
  type DebitResult,
  type DebitTxn,
} from "./debit-parser";

import {
  detectMode,
  extractDate,
  findColumns,
  formatAmount,
  isAnyDebit,
  isUpiCredit,
  normalizeText,
  parseMoney,
  parseStatementRows,
  parseStatementText,
  type ColumnMap,
  type CoreResult,
  type CoreTransaction,
  type Row,
} from "./statement-core";

/* ========================================================================== *
 * STATEMENT READERS — V5 SAFE
 *
 * Important:
 * - statement-core.ts remains untouched.
 * - Generic XLS/XLSX/CSV/TXT parsing remains on the existing core parser.
 * - Exact Withdrawals/Deposits/Balance statements get a narrow adapter.
 * - PDF parsing is temporarily disabled so it cannot affect parser accuracy.
 * - Image OCR remains available.
 * ========================================================================== */

export type CombinedResult = {
  credit: ExtractResult;
  debit: DebitResult;
  warnings: string[];
};

export type ExtractProgress = (
  stage: string,
) => void;

/* ========================================================================== *
 * CORE -> PUBLIC RESULT
 * ========================================================================== */

function toCredit(
  transaction: CoreTransaction,
): UpiCredit | null {
  if (
    !isUpiCredit(transaction) ||
    transaction.amount === null ||
    transaction.amount <= 0
  ) {
    return null;
  }

  return {
    date: transaction.date,
    utr: transaction.reference ?? "N/A",
    amount: formatAmount(transaction.amount),
    mode: "UPI",
  };
}

function toDebit(
  transaction: CoreTransaction,
): DebitTxn | null {
  if (
    !isAnyDebit(transaction) ||
    transaction.amount === null ||
    transaction.amount <= 0
  ) {
    return null;
  }

  return {
    date: transaction.date,
    utr: transaction.reference ?? "N/A",
    amount: formatAmount(transaction.amount),
    mode: transaction.mode,
  };
}

function creditKey(
  row: UpiCredit,
): string | null {
  if (row.utr === "N/A") {
    return null;
  }

  return [
    row.utr,
    row.amount,
    row.mode,
  ]
    .join("|")
    .toUpperCase();
}

function debitKey(
  row: DebitTxn,
): string | null {
  if (row.utr === "N/A") {
    return null;
  }

  return [
    row.utr,
    row.amount,
    row.mode,
  ]
    .join("|")
    .toUpperCase();
}

function dedupeCredits(
  rows: UpiCredit[],
): UpiCredit[] {
  const seen = new Set<string>();
  const output: UpiCredit[] = [];

  for (const row of rows) {
    const key = creditKey(row);

    if (key !== null) {
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
    }

    output.push(row);
  }

  return output;
}

function dedupeDebits(
  rows: DebitTxn[],
): DebitTxn[] {
  const seen = new Set<string>();
  const output: DebitTxn[] = [];

  for (const row of rows) {
    const key = debitKey(row);

    if (key !== null) {
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
    }

    output.push(row);
  }

  return output;
}

function diagnosticReason(
  transaction: CoreTransaction,
  accepted: boolean,
): string | undefined {
  if (accepted) {
    return undefined;
  }

  if (transaction.mode !== "UPI") {
    return "Not a UPI transaction";
  }

  if (transaction.direction === "debit") {
    return "UPI debit row";
  }

  if (transaction.direction === "unknown") {
    return "Transaction direction could not be proven as credit";
  }

  if (
    transaction.amount === null ||
    transaction.amount <= 0
  ) {
    return "No valid credit amount";
  }

  return "Not accepted as UPI credit";
}

function makeDiagnostic(
  transaction: CoreTransaction,
): RowDiagnostic {
  const accepted =
    isUpiCredit(transaction) &&
    transaction.amount !== null &&
    transaction.amount > 0;

  const result: RowDiagnostic = {
    index: transaction.rowIndex,
    preview: transaction.raw.slice(0, 220),
    hasDate: Boolean(transaction.date),
    isUpi: transaction.mode === "UPI",
    references: transaction.reference ? 1 : 0,
    direction: transaction.direction,
    amount:
      transaction.amount === null
        ? null
        : formatAmount(transaction.amount),
    accepted,
  };

  const reason =
    diagnosticReason(
      transaction,
      accepted,
    );

  if (reason !== undefined) {
    result.reason = reason;
  }

  return result;
}

function combinedFromCore(
  core: CoreResult,
  inputLines = 0,
  extraWarnings: string[] = [],
): CombinedResult {
  const creditRows =
    dedupeCredits(
      core.transactions
        .map(toCredit)
        .filter(
          (
            row,
          ): row is UpiCredit =>
            row !== null,
        ),
    );

  const debitRows =
    dedupeDebits(
      core.transactions
        .map(toDebit)
        .filter(
          (
            row,
          ): row is DebitTxn =>
            row !== null,
        ),
    );

  const paymentRows =
    debitRows.filter(
      (row) =>
        row.mode === "UPI" ||
        row.mode === "IMPS" ||
        row.mode === "NEFT" ||
        row.mode === "RTGS",
    );

  const otherRows =
    debitRows.filter(
      (row) =>
        row.mode === "OTHER",
    );

  const debug: ExtractDebug = {
    inputLines,

    transactionRows:
      core.transactions.length,

    upiRows:
      core.transactions.filter(
        (transaction) =>
          transaction.mode === "UPI",
      ).length,

    rowsWithReference:
      core.transactions.filter(
        (transaction) =>
          Boolean(transaction.reference),
      ).length,

    creditRows:
      core.transactions.filter(
        (transaction) =>
          transaction.direction === "credit",
      ).length,

    accepted:
      creditRows.length,

    columns:
      core.columns,

    rows:
      core.transactions.map(
        makeDiagnostic,
      ),
  };

  return {
    credit: {
      rows: creditRows,
      debug,
    },

    debit: {
      rows: debitRows,
      allRows: debitRows,
      paymentRows,
      otherRows,
    },

    warnings: [
      ...new Set([
        ...core.warnings,
        ...extraWarnings,
      ]),
    ],
  };
}

function emptyCombined(): CombinedResult {
  return combinedFromCore({
    transactions: [],
    columns: null,
    summary: null,
    warnings: [],
  });
}

export function mergeCombined(
  list: CombinedResult[],
): CombinedResult {
  if (list.length === 0) {
    return emptyCombined();
  }

  const credits =
    dedupeCredits(
      list.flatMap(
        (result) =>
          result.credit.rows,
      ),
    );

  const debits =
    dedupeDebits(
      list.flatMap(
        (result) =>
          result.debit.rows,
      ),
    );

  const paymentRows =
    debits.filter(
      (row) =>
        row.mode === "UPI" ||
        row.mode === "IMPS" ||
        row.mode === "NEFT" ||
        row.mode === "RTGS",
    );

  const otherRows =
    debits.filter(
      (row) =>
        row.mode === "OTHER",
    );

  const columns =
    list.find(
      (result) =>
        result.credit.debug.columns !== null,
    )?.credit.debug.columns ??
    null;

  return {
    credit: {
      rows: credits,

      debug: {
        inputLines:
          list.reduce(
            (total, result) =>
              total +
              result.credit.debug.inputLines,
            0,
          ),

        transactionRows:
          list.reduce(
            (total, result) =>
              total +
              result.credit.debug.transactionRows,
            0,
          ),

        upiRows:
          list.reduce(
            (total, result) =>
              total +
              result.credit.debug.upiRows,
            0,
          ),

        rowsWithReference:
          list.reduce(
            (total, result) =>
              total +
              result.credit.debug.rowsWithReference,
            0,
          ),

        creditRows:
          list.reduce(
            (total, result) =>
              total +
              result.credit.debug.creditRows,
            0,
          ),

        accepted:
          credits.length,

        columns,

        rows:
          list.flatMap(
            (result) =>
              result.credit.debug.rows,
          ),
      },
    },

    debit: {
      rows: debits,
      allRows: debits,
      paymentRows,
      otherRows,
    },

    warnings: [
      ...new Set(
        list.flatMap(
          (result) =>
            result.warnings,
        ),
      ),
    ],
  };
}

/* ========================================================================== *
 * TEXT
 * ========================================================================== */

function fromText(
  text: string,
  extraWarnings: string[] = [],
): CombinedResult {
  const normalized =
    String(text ?? "");

  const core =
    parseStatementText(
      normalized,
    );

  const inputLines =
    normalized
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .filter(
        (line) =>
          Boolean(line.trim()),
      ).length;

  return combinedFromCore(
    core,
    inputLines,
    extraWarnings,
  );
}

/* ========================================================================== *
 * IMAGE OCR
 * ========================================================================== */

async function fileToDataUrl(
  file: File,
): Promise<string> {
  return await new Promise<string>(
    (
      resolve,
      reject,
    ) => {
      const reader =
        new FileReader();

      reader.onload = () =>
        resolve(
          String(
            reader.result ?? "",
          ),
        );

      reader.onerror = () =>
        reject(
          new Error(
            "Could not read the image.",
          ),
        );

      reader.readAsDataURL(
        file,
      );
    },
  );
}

async function ocrImages(
  images: string[],
): Promise<string> {
  if (images.length === 0) {
    return "";
  }

  const result =
    await ocrStatementPages({
      data: {
        images,
      },
    });

  return String(
    result.text ?? "",
  );
}

/* ========================================================================== *
 * SPREADSHEET TYPES
 * ========================================================================== */

type WorkbookSheet = {
  name: string;
  rows: Row[];
};

function excelCellText(
  value: unknown,
): string {
  if (
    value instanceof Date &&
    !Number.isNaN(
      value.getTime(),
    )
  ) {
    const dd =
      String(
        value.getDate(),
      ).padStart(
        2,
        "0",
      );

    const mm =
      String(
        value.getMonth() + 1,
      ).padStart(
        2,
        "0",
      );

    return `${dd}/${mm}/${value.getFullYear()}`;
  }

  return normalizeText(
    value,
  );
}

async function readWorkbookSheets(
  file: File,
): Promise<WorkbookSheet[]> {
  const XLSX =
    await import(
      "xlsx"
    );

  const workbook =
    XLSX.read(
      await file.arrayBuffer(),
      {
        type: "array",
        raw: false,
        cellDates: true,
      },
    );

  const sheets:
    WorkbookSheet[] = [];

  for (
    const sheetName of
      workbook.SheetNames
  ) {
    const sheet =
      workbook.Sheets[
        sheetName
      ];

    if (!sheet) {
      continue;
    }

    const data =
      XLSX.utils.sheet_to_json(
        sheet,
        {
          header: 1,
          defval: "",
          raw: false,
          blankrows: false,
        },
      ) as unknown[][];

    const rows: Row[] =
      data
        .map(
          (row) =>
            row.map(
              excelCellText,
            ),
        )
        .filter(
          (row) =>
            row.some(Boolean),
        );

    if (
      rows.length > 0
    ) {
      sheets.push({
        name: sheetName,
        rows,
      });
    }
  }

  return sheets;
}

/* ========================================================================== *
 * EXACT WITHDRAWALS / DEPOSITS / BALANCE ADAPTER
 *
 * Narrow activation only:
 *
 * Date | Particulars | Withdrawals | Deposits | Balance
 *
 * All other spreadsheets stay on the normal statement-core parser.
 * ========================================================================== */

type ExactStatementColumns = {
  date: number;
  narration: number;
  debit: number;
  credit: number;
  balance: number;
};

type ExactHeaderMatch = {
  columns: ExactStatementColumns;
  headerIndex: number;
};

function normalizedHeaderCell(
  value: unknown,
): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[.:()_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findExactStatementHeader(
  rows: Row[],
): ExactHeaderMatch | null {
  const limit =
    Math.min(
      rows.length,
      80,
    );

  for (
    let rowIndex = 0;
    rowIndex < limit;
    rowIndex++
  ) {
    const row =
      rows[rowIndex] ?? [];

    const cells =
      row.map(
        normalizedHeaderCell,
      );

    const date =
      cells.findIndex(
        (cell) =>
          cell === "date" ||
          cell === "transaction date" ||
          cell === "txn date",
      );

    const narration =
      cells.findIndex(
        (cell) =>
          cell === "particulars" ||
          cell === "particular" ||
          cell === "narration",
      );

    const debit =
      cells.findIndex(
        (cell) =>
          cell === "withdrawals" ||
          cell === "withdrawal",
      );

    const credit =
      cells.findIndex(
        (cell) =>
          cell === "deposits" ||
          cell === "deposit",
      );

    const balance =
      cells.findIndex(
        (cell) =>
          cell === "balance" ||
          cell === "running balance",
      );

    if (
      date >= 0 &&
      narration >= 0 &&
      debit >= 0 &&
      credit >= 0 &&
      balance >= 0
    ) {
      const unique =
        new Set([
          date,
          narration,
          debit,
          credit,
          balance,
        ]);

      if (
        unique.size !== 5
      ) {
        continue;
      }

      return {
        columns: {
          date,
          narration,
          debit,
          credit,
          balance,
        },

        headerIndex:
          rowIndex,
      };
    }
  }

  return null;
}

function moneyParts(
  value: unknown,
): string[] {
  const text =
    normalizeText(
      value,
    );

  if (!text) {
    return [];
  }

  return (
    text.match(
      /[+-]?(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?/g,
    ) ?? []
  );
}

function firstMoney(
  values: string[],
): number | null {
  for (
    const value of values
  ) {
    const amount =
      parseMoney(
        value,
      );

    if (
      amount !== null &&
      Number.isFinite(
        amount,
      )
    ) {
      return Math.abs(
        amount,
      );
    }
  }

  return null;
}

function exactReference(
  narration: string,
): string {
  const text =
    normalizeText(
      narration,
    );

  const patterns: RegExp[] = [
    /\bUPI\/(?:CR|DR)\/(\d{10,18})(?=\/|$)/i,

    /\bIMPS\/(?:P2A\/|P2P\/)?(\d{10,18})(?=\/|$)/i,

    /\bNEFT[-/:]([A-Z0-9]{8,40})(?=[-/: ]|$)/i,

    /\bRTGS[-/:]([A-Z0-9]{8,40})(?=[-/: ]|$)/i,

    /\b(?:PORD\s+Customer\s+Payment|Pymnt)\s*:?\s*([A-Z0-9]{8,40})\b/i,
  ];

  for (
    const pattern of patterns
  ) {
    const match =
      pattern.exec(
        text,
      );

    if (
      match?.[1]
    ) {
      return match[1]
        .toUpperCase();
    }
  }

  return "N/A";
}

function isExactUpiCredit(
  narration: string,
): boolean {
  return (
    /(?:^|[/_: -])UPI[/_: -]+CR(?:[/_: -]|$)/i.test(
      normalizeText(
        narration,
      ),
    )
  );
}

function looksLikeKnownDebitNarration(
  narration: string,
): boolean {
  const text =
    normalizeText(
      narration,
    );

  return (
    /(?:^|[/_: -])UPI[/_: -]+DR(?:[/_: -]|$)/i.test(
      text,
    ) ||
    /\bIMPS\b/i.test(
      text,
    ) ||
    /\bNEFT\b/i.test(
      text,
    ) ||
    /\bRTGS\b/i.test(
      text,
    ) ||
    /\bcharges?\b/i.test(
      text,
    ) ||
    /\bchrgs?\b/i.test(
      text,
    ) ||
    /\bcheque\s+book\s+charges?\b/i.test(
      text,
    ) ||
    /\bBY\s+INST\b/i.test(
      text,
    )
  );
}

function looksLikeExactContinuation(
  rows: Row[],
  columns: ExactStatementColumns,
): boolean {
  let dated = 0;
  let transactionLike = 0;

  for (
    const row of
      rows.slice(
        0,
        50,
      )
  ) {
    const date =
      extractDate(
        row[
          columns.date
        ] ?? "",
      );

    if (!date) {
      continue;
    }

    dated++;

    const narration =
      normalizeText(
        row[
          columns.narration
        ] ?? "",
      );

    if (
      isExactUpiCredit(
        narration,
      ) ||
      looksLikeKnownDebitNarration(
        narration,
      )
    ) {
      transactionLike++;
    }
  }

  return (
    dated >= 2 &&
    transactionLike >= 1
  );
}

function makeExactCombined(
  sheet: WorkbookSheet,
  columns: ExactStatementColumns,
  startIndex: number,
): CombinedResult {
  const credits:
    UpiCredit[] = [];

  const debits:
    DebitTxn[] = [];

  let transactionRows = 0;
  let upiRows = 0;
  let rowsWithReference = 0;

  for (
    let rowIndex =
      Math.max(
        0,
        startIndex,
      );
    rowIndex <
    sheet.rows.length;
    rowIndex++
  ) {
    const row =
      sheet.rows[
        rowIndex
      ] ?? [];

    const rawDate =
      row[
        columns.date
      ] ?? "";

    const date =
      extractDate(
        rawDate,
      );

    if (!date) {
      continue;
    }

    const narration =
      normalizeText(
        row[
          columns.narration
        ] ?? "",
      );

    if (!narration) {
      continue;
    }

    const debitParts =
      moneyParts(
        row[
          columns.debit
        ] ?? "",
      );

    const creditParts =
      moneyParts(
        row[
          columns.credit
        ] ?? "",
      );

    const balanceParts =
      moneyParts(
        row[
          columns.balance
        ] ?? "",
      );

    const upiCredit =
      isExactUpiCredit(
        narration,
      );

    let debitAmount:
      number | null =
      null;

    let creditAmount:
      number | null =
      null;

    /*
     * NORMAL TABLE:
     *
     * Date
     * Particulars
     * Withdrawals
     * Deposits
     * Balance
     */
    if (
      balanceParts.length > 0
    ) {
      debitAmount =
        firstMoney(
          debitParts,
        );

      creditAmount =
        firstMoney(
          creditParts,
        );
    } else {
      /*
       * MALFORMED GENERATED EXPORT:
       *
       * Running balance may be shifted one cell left.
       *
       * UPI credit:
       *
       * debit=""
       * credit="1500.00 172663.09"
       * balance=""
       *
       * OR
       *
       * debit="1500.00"
       * credit="172663.09"
       * balance=""
       *
       * Debit:
       *
       * debit="340200.00"
       * credit="4091.91"
       * balance=""
       */

      if (upiCredit) {
        if (
          debitParts.length === 0 &&
          creditParts.length >= 1
        ) {
          creditAmount =
            firstMoney(
              creditParts,
            );
        } else if (
          debitParts.length >= 1 &&
          creditParts.length >= 1
        ) {
          creditAmount =
            firstMoney(
              debitParts,
            );
        } else if (
          debitParts.length >= 2 &&
          creditParts.length === 0
        ) {
          creditAmount =
            firstMoney(
              debitParts,
            );
        }
      } else {
        if (
          debitParts.length >= 1
        ) {
          debitAmount =
            firstMoney(
              debitParts,
            );
        }
      }
    }

    const reference =
      exactReference(
        narration,
      );

    const mode =
      detectMode(
        narration,
      );

    let accepted = false;

    if (
      upiCredit &&
      creditAmount !== null &&
      creditAmount > 0
    ) {
      credits.push({
        date,
        utr: reference,
        amount:
          formatAmount(
            creditAmount,
          ),
        mode: "UPI",
      });

      accepted = true;
      upiRows++;
    }

    if (
      debitAmount !== null &&
      debitAmount > 0
    ) {
      debits.push({
        date,
        utr: reference,
        amount:
          formatAmount(
            debitAmount,
          ),
        mode,
      });

      accepted = true;

      if (
        mode === "UPI"
      ) {
        upiRows++;
      }
    }

    if (accepted) {
      transactionRows++;

      if (
        reference !== "N/A"
      ) {
        rowsWithReference++;
      }
    }
  }

  const cleanCredits =
    dedupeCredits(
      credits,
    );

  const cleanDebits =
    dedupeDebits(
      debits,
    );

  const paymentRows =
    cleanDebits.filter(
      (row) =>
        row.mode === "UPI" ||
        row.mode === "IMPS" ||
        row.mode === "NEFT" ||
        row.mode === "RTGS",
    );

  const otherRows =
    cleanDebits.filter(
      (row) =>
        row.mode === "OTHER",
    );

  const coreColumns:
    ColumnMap = {
      date:
        columns.date,

      narration:
        columns.narration,

      debit:
        columns.debit,

      credit:
        columns.credit,

      balance:
        columns.balance,
    };

  return {
    credit: {
      rows:
        cleanCredits,

      debug: {
        inputLines:
          sheet.rows.length,

        transactionRows,

        upiRows,

        rowsWithReference,

        creditRows:
          cleanCredits.length,

        accepted:
          cleanCredits.length,

        columns:
          coreColumns,

        rows: [],
      },
    },

    debit: {
      rows:
        cleanDebits,

      allRows:
        cleanDebits,

      paymentRows,

      otherRows,
    },

    warnings: [],
  };
}

/* ========================================================================== *
 * WORKBOOK PARSER
 * ========================================================================== */

function parseWorkbook(
  sheets: WorkbookSheet[],
  onProgress?: ExtractProgress,
): CombinedResult {
  if (
    sheets.length === 0
  ) {
    return emptyCombined();
  }

  const results:
    CombinedResult[] = [];

  let inheritedColumns:
    ColumnMap | null =
    null;

  let exactColumns:
    ExactStatementColumns | null =
    null;

  for (
    let index = 0;
    index < sheets.length;
    index++
  ) {
    const sheet =
      sheets[index];

    if (!sheet) {
      continue;
    }

    onProgress?.(
      `Reading sheet ${index + 1} of ${sheets.length}…`,
    );

    const exactHeader =
      findExactStatementHeader(
        sheet.rows,
      );

    /*
     * Special deterministic adapter.
     *
     * This path ONLY activates when the exact header family exists.
     */
    if (exactHeader) {
      exactColumns =
        exactHeader.columns;

      results.push(
        makeExactCombined(
          sheet,
          exactColumns,
          exactHeader.headerIndex + 1,
        ),
      );

      continue;
    }

    /*
     * Continuation sheet:
     * same statement but header not repeated.
     */
    if (
      exactColumns !== null &&
      looksLikeExactContinuation(
        sheet.rows,
        exactColumns,
      )
    ) {
      results.push(
        makeExactCombined(
          sheet,
          exactColumns,
          0,
        ),
      );

      continue;
    }

    /*
     * GENERIC PATH.
     *
     * No special ACSTMT mutation is performed here.
     * Existing statement-core parser handles every other bank/export.
     */
    const detected =
      findColumns(
        sheet.rows,
      ).columns;

    if (
      detected !== null
    ) {
      inheritedColumns =
        detected;
    }

    const activeColumns =
      detected ??
      inheritedColumns;

    const core =
      parseStatementRows(
        sheet.rows,
        activeColumns,
      );

    results.push(
      combinedFromCore(
        core,
        sheet.rows.length,
      ),
    );
  }

  return mergeCombined(
    results,
  );
}

/* ========================================================================== *
 * MAIN FILE READER
 * ========================================================================== */

export async function extractFromFile(
  file: File,
  onProgress?: ExtractProgress,
): Promise<CombinedResult> {
  const name =
    file.name.toLowerCase();

  const type =
    file.type.toLowerCase();

  const isImage =
    type.startsWith(
      "image/",
    ) ||
    /\.(jpg|jpeg|png|webp|bmp|tif|tiff)$/i.test(
      name,
    );

  if (isImage) {
    onProgress?.(
      "Reading statement image…",
    );

    const image =
      await fileToDataUrl(
        file,
      );

    let text = "";

    try {
      text =
        await ocrImages([
          image,
        ]);
    } catch {
      throw new Error(
        "OCR could not read this statement image.",
      );
    }

    if (
      !text.trim()
    ) {
      throw new Error(
        "No readable bank statement transactions were found in this image.",
      );
    }

    return fromText(
      text,
    );
  }

  /*
   * PDF IS INTENTIONALLY DISABLED.
   *
   * Do not run PDF.js or multi-page OCR while spreadsheet accuracy is being
   * stabilized. This prevents slow PDF work from affecting the rest of the
   * statement parser.
   */
  if (
    name.endsWith(
      ".pdf",
    ) ||
    type ===
      "application/pdf"
  ) {
    onProgress?.(
      "PDF parsing is temporarily unavailable.",
    );

    throw new Error(
      "PDF parsing is temporarily disabled while statement accuracy is being stabilized. Please upload XLS, XLSX, CSV or TXT.",
    );
  }

  if (
    /\.(xls|xlsx|csv)$/i.test(
      name,
    ) ||
    type === "text/csv" ||
    type.includes(
      "spreadsheet",
    ) ||
    type.includes(
      "excel",
    )
  ) {
    onProgress?.(
      "Opening spreadsheet…",
    );

    let sheets:
      WorkbookSheet[];

    try {
      sheets =
        await readWorkbookSheets(
          file,
        );
    } catch {
      throw new Error(
        "Unable to read this spreadsheet file.",
      );
    }

    if (
      sheets.length === 0
    ) {
      throw new Error(
        "No readable statement rows were found in this spreadsheet.",
      );
    }

    return parseWorkbook(
      sheets,
      onProgress,
    );
  }

  onProgress?.(
    "Reading text statement…",
  );

  let text: string;

  try {
    text =
      await file.text();
  } catch {
    throw new Error(
      "Unable to read this text file.",
    );
  }

  if (
    !text.trim()
  ) {
    throw new Error(
      "This text statement is empty.",
    );
  }

  return fromText(
    text,
  );
}
