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
  findColumns,
  formatAmount,
  isAnyDebit,
  isUpiCredit,
  normalizeText,
  parseStatementRows,
  parseStatementText,
  type ColumnMap,
  type CoreResult,
  type CoreTransaction,
  type Row,
} from "./statement-core";

/* ========================================================================== *
 * PUBLIC TYPES
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
 * CORE -> PUBLIC TRANSACTIONS
 * ========================================================================== */

function toCredit(
  transaction: CoreTransaction,
): UpiCredit | null {
  if (
    !isUpiCredit(
      transaction,
    ) ||
    transaction.amount ===
      null ||
    transaction.amount <=
      0
  ) {
    return null;
  }

  return {
    date:
      transaction.date,

    utr:
      transaction.reference ??
      "N/A",

    amount:
      formatAmount(
        transaction.amount,
      ),

    mode:
      "UPI",
  };
}

function toDebit(
  transaction: CoreTransaction,
): DebitTxn | null {
  if (
    !isAnyDebit(
      transaction,
    ) ||
    transaction.amount ===
      null ||
    transaction.amount <=
      0
  ) {
    return null;
  }

  return {
    date:
      transaction.date,

    utr:
      transaction.reference ??
      "N/A",

    amount:
      formatAmount(
        transaction.amount,
      ),

    mode:
      transaction.mode,
  };
}

/* ========================================================================== *
 * DEDUPE
 * ========================================================================== */

function dedupeCredits(
  rows: UpiCredit[],
): UpiCredit[] {
  const seen =
    new Set<string>();

  const output:
    UpiCredit[] = [];

  for (
    const row of rows
  ) {
    /*
     * Do not aggressively dedupe transactions without UTR.
     */
    if (
      row.utr ===
      "N/A"
    ) {
      output.push(
        row,
      );

      continue;
    }

    const key =
      [
        row.utr,
        row.amount,
        row.mode,
      ]
        .join("|")
        .toUpperCase();

    if (
      seen.has(
        key,
      )
    ) {
      continue;
    }

    seen.add(
      key,
    );

    output.push(
      row,
    );
  }

  return output;
}

function dedupeDebits(
  rows: DebitTxn[],
): DebitTxn[] {
  const seen =
    new Set<string>();

  const output:
    DebitTxn[] = [];

  for (
    const row of rows
  ) {
    if (
      row.utr ===
      "N/A"
    ) {
      output.push(
        row,
      );

      continue;
    }

    const key =
      [
        row.utr,
        row.mode,
        row.amount,
      ]
        .join("|")
        .toUpperCase();

    if (
      seen.has(
        key,
      )
    ) {
      continue;
    }

    seen.add(
      key,
    );

    output.push(
      row,
    );
  }

  return output;
}

/* ========================================================================== *
 * DEBUG
 * ========================================================================== */

function diagnosticReason(
  transaction:
    CoreTransaction,
  accepted:
    boolean,
): string | undefined {
  if (
    accepted
  ) {
    return undefined;
  }

  if (
    transaction.mode !==
    "UPI"
  ) {
    return "Not a UPI transaction";
  }

  if (
    transaction.direction ===
    "debit"
  ) {
    return "UPI debit row";
  }

  if (
    transaction.direction ===
    "unknown"
  ) {
    return "Transaction direction could not be proven as credit";
  }

  if (
    transaction.amount ===
      null ||
    transaction.amount <=
      0
  ) {
    return "No valid credit amount";
  }

  return "Not accepted as UPI credit";
}

function makeDiagnostic(
  transaction:
    CoreTransaction,
): RowDiagnostic {
  const accepted =
    isUpiCredit(
      transaction,
    ) &&
    transaction.amount !==
      null &&
    transaction.amount >
      0;

  const result:
    RowDiagnostic = {
      index:
        transaction.rowIndex,

      preview:
        transaction.raw.slice(
          0,
          220,
        ),

      hasDate:
        Boolean(
          transaction.date,
        ),

      isUpi:
        transaction.mode ===
        "UPI",

      references:
        transaction.reference
          ? 1
          : 0,

      direction:
        transaction.direction,

      amount:
        transaction.amount ===
        null
          ? null
          : formatAmount(
              transaction.amount,
            ),

      accepted,
    };

  const reason =
    diagnosticReason(
      transaction,
      accepted,
    );

  /*
   * exactOptionalPropertyTypes safe.
   */
  if (
    reason !==
    undefined
  ) {
    result.reason =
      reason;
  }

  return result;
}

/* ========================================================================== *
 * CORE RESULT -> UI RESULT
 * ========================================================================== */

function combinedFromCore(
  core:
    CoreResult,
  inputLines =
    0,
  extraWarnings:
    string[] = [],
): CombinedResult {
  const creditRows =
    dedupeCredits(
      core.transactions
        .map(
          toCredit,
        )
        .filter(
          (
            row,
          ): row is UpiCredit =>
            row !==
            null,
        ),
    );

  const debitRows =
    dedupeDebits(
      core.transactions
        .map(
          toDebit,
        )
        .filter(
          (
            row,
          ): row is DebitTxn =>
            row !==
            null,
        ),
    );

  const paymentRows =
    debitRows.filter(
      (
        row,
      ) =>
        row.mode ===
          "UPI" ||
        row.mode ===
          "IMPS" ||
        row.mode ===
          "NEFT" ||
        row.mode ===
          "RTGS",
    );

  const otherRows =
    debitRows.filter(
      (
        row,
      ) =>
        row.mode ===
        "OTHER",
    );

  const debug:
    ExtractDebug = {
      inputLines,

      transactionRows:
        core.transactions
          .length,

      upiRows:
        core.transactions
          .filter(
            (
              transaction,
            ) =>
              transaction.mode ===
              "UPI",
          )
          .length,

      rowsWithReference:
        core.transactions
          .filter(
            (
              transaction,
            ) =>
              Boolean(
                transaction.reference,
              ),
          )
          .length,

      creditRows:
        core.transactions
          .filter(
            (
              transaction,
            ) =>
              transaction.direction ===
              "credit",
          )
          .length,

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
      rows:
        creditRows,

      debug,
    },

    debit: {
      rows:
        debitRows,

      allRows:
        debitRows,

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

/* ========================================================================== *
 * MULTIPLE FILE MERGE
 * ========================================================================== */

export function mergeCombined(
  list:
    CombinedResult[],
): CombinedResult {
  if (
    list.length ===
    0
  ) {
    return emptyCombined();
  }

  const credits =
    dedupeCredits(
      list.flatMap(
        (
          result,
        ) =>
          result.credit.rows,
      ),
    );

  const debits =
    dedupeDebits(
      list.flatMap(
        (
          result,
        ) =>
          result.debit.rows,
      ),
    );

  const paymentRows =
    debits.filter(
      (
        row,
      ) =>
        row.mode ===
          "UPI" ||
        row.mode ===
          "IMPS" ||
        row.mode ===
          "NEFT" ||
        row.mode ===
          "RTGS",
    );

  const otherRows =
    debits.filter(
      (
        row,
      ) =>
        row.mode ===
        "OTHER",
    );

  const columns =
    list.find(
      (
        result,
      ) =>
        result.credit
          .debug.columns !==
        null,
    )?.credit.debug
      .columns ??
    null;

  return {
    credit: {
      rows:
        credits,

      debug: {
        inputLines:
          list.reduce(
            (
              total,
              result,
            ) =>
              total +
              result.credit
                .debug.inputLines,
            0,
          ),

        transactionRows:
          list.reduce(
            (
              total,
              result,
            ) =>
              total +
              result.credit
                .debug
                .transactionRows,
            0,
          ),

        upiRows:
          list.reduce(
            (
              total,
              result,
            ) =>
              total +
              result.credit
                .debug.upiRows,
            0,
          ),

        rowsWithReference:
          list.reduce(
            (
              total,
              result,
            ) =>
              total +
              result.credit
                .debug
                .rowsWithReference,
            0,
          ),

        creditRows:
          list.reduce(
            (
              total,
              result,
            ) =>
              total +
              result.credit
                .debug.creditRows,
            0,
          ),

        accepted:
          credits.length,

        columns,

        rows:
          list.flatMap(
            (
              result,
            ) =>
              result.credit
                .debug.rows,
          ),
      },
    },

    debit: {
      rows:
        debits,

      allRows:
        debits,

      paymentRows,

      otherRows,
    },

    warnings: [
      ...new Set(
        list.flatMap(
          (
            result,
          ) =>
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
  text:
    string,
  extraWarnings:
    string[] = [],
): CombinedResult {
  const normalized =
    String(
      text ??
      "",
    );

  const core =
    parseStatementText(
      normalized,
    );

  const inputLines =
    normalized
      .replace(
        /\r\n?/g,
        "\n",
      )
      .split(
        "\n",
      )
      .filter(
        (
          line,
        ) =>
          Boolean(
            line.trim(),
          ),
      )
      .length;

  return combinedFromCore(
    core,
    inputLines,
    extraWarnings,
  );
}

/* ========================================================================== *
 * MALFORMED BANK EXPORT REPAIR
 *
 * Some bank PDF->XLS/XLSX exports contain:
 *
 * Header:
 * Date | Particulars | Withdrawals | Deposits | Balance
 *
 * but actual rows may be:
 *
 * Debit row:
 * Date | Narration | 299923.60 | 2453.35 | EMPTY
 *
 * where 2453.35 is actually BALANCE.
 *
 * Credit row:
 * Date | Narration | EMPTY | "6000.00 302376.95" | EMPTY
 *
 * where:
 * 6000.00   = Credit
 * 302376.95 = Balance
 *
 * We repair these rows BEFORE statement-core sees them.
 * ========================================================================== */

function moneyParts(
  value:
    unknown,
): string[] {
  const text =
    normalizeText(
      value,
    );

  if (
    !text
  ) {
    return [];
  }

  return (
    text.match(
      /[+-]?(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?/g,
    ) ??
    []
  );
}

function strongCreditNarration(
  text:
    string,
): boolean {
  const normalized =
    normalizeText(
      text,
    );

  return (
    /(?:^|[/_: -])UPI[/_: -]+CR(?:[/_: -]|$)/i.test(
      normalized,
    ) ||
    /\b(?:credited|credit received|amount received|deposited)\b/i.test(
      normalized,
    )
  );
}

function repairShiftedAmountBalanceRows(
  inputRows:
    Row[],
  inheritedColumns:
    ColumnMap | null =
    null,
): Row[] {
  /*
   * Never mutate original rows.
   */
  const rows:
    Row[] =
    inputRows.map(
      (
        row,
      ) =>
        row.map(
          (
            cell,
          ) =>
            normalizeText(
              cell,
            ),
        ),
    );

  const detected =
    findColumns(
      rows,
    );

  const columns =
    detected.columns ??
    inheritedColumns;

  /*
   * This repair is only enabled when the statement genuinely
   * declares Debit + Credit + Balance columns.
   */
  if (
    columns?.debit ===
      undefined ||
    columns.credit ===
      undefined ||
    columns.balance ===
      undefined
  ) {
    return rows;
  }

  for (
    const row of rows
  ) {
    const balanceCell =
      normalizeText(
        row[
          columns.balance
        ] ??
        "",
      );

    /*
     * Correct normal row.
     * Never touch it.
     */
    if (
      balanceCell
    ) {
      continue;
    }

    const debitCell =
      normalizeText(
        row[
          columns.debit
        ] ??
        "",
      );

    const creditCell =
      normalizeText(
        row[
          columns.credit
        ] ??
        "",
      );

    const debitParts =
      moneyParts(
        debitCell,
      );

    const creditParts =
      moneyParts(
        creditCell,
      );

    const narration =
      columns.narration ===
      undefined
        ? row.join(
            " ",
          )
        : normalizeText(
            row[
              columns.narration
            ] ??
            "",
          );

    /*
     * --------------------------------------------------------------
     * CASE 1
     *
     * Credit + balance have been merged into Deposit/Credit cell.
     *
     * Example:
     *
     * Credit cell:
     * "6000.00          302376.95"
     *
     * Debit:
     * empty
     *
     * Balance:
     * empty
     * --------------------------------------------------------------
     */

    if (
      debitParts.length ===
        0 &&
      creditParts.length >=
        2
    ) {
      row[
        columns.credit
      ] =
        creditParts[0] ??
        "";

      row[
        columns.balance
      ] =
        creditParts[
          creditParts.length -
          1
        ] ??
        "";

      continue;
    }

    /*
     * --------------------------------------------------------------
     * CASE 2
     *
     * Debit + balance have been merged into Withdrawal/Debit cell.
     * --------------------------------------------------------------
     */

    if (
      creditParts.length ===
        0 &&
      debitParts.length >=
        2
    ) {
      row[
        columns.debit
      ] =
        debitParts[0] ??
        "";

      row[
        columns.balance
      ] =
        debitParts[
          debitParts.length -
          1
        ] ??
        "";

      continue;
    }

    /*
     * --------------------------------------------------------------
     * CASE 3
     *
     * PDF->XLS export shifted running Balance one column left.
     *
     * Header says:
     *
     * Debit | Credit | Balance
     *
     * Actual debit row:
     *
     * 299923.60 | 2453.35 | EMPTY
     *
     * Correct interpretation:
     *
     * Debit   = 299923.60
     * Credit  = empty
     * Balance = 2453.35
     *
     * We only do this if narration is NOT explicitly credit.
     * --------------------------------------------------------------
     */

    if (
      debitParts.length ===
        1 &&
      creditParts.length ===
        1 &&
      !strongCreditNarration(
        narration,
      )
    ) {
      row[
        columns.balance
      ] =
        creditParts[0] ??
        "";

      row[
        columns.credit
      ] =
        "";
    }
  }

  return rows;
}

/* ========================================================================== *
 * PDF.JS
 *
 * Safari/iPhone:
 *
 * Prefer legacy PDF.js build.
 * Fall back to standard build if legacy import is unavailable.
 * ========================================================================== */

async function loadPdfjs(): Promise<any> {
  /*
   * Legacy PDF.js is safer for Safari/WebView environments.
   */
  try {
    const pdfjs =
      await import(
        "pdfjs-dist/legacy/build/pdf.mjs"
      );

    try {
      const worker =
        await import(
          "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"
        );

      if (
        pdfjs.GlobalWorkerOptions &&
        typeof worker.default ===
          "string"
      ) {
        pdfjs.GlobalWorkerOptions.workerSrc =
          worker.default;
      }
    } catch {
      /*
       * Do not crash merely because explicit worker URL import failed.
       * getDocument() will still produce a readable error if PDF.js
       * cannot initialize.
       */
    }

    return pdfjs;
  } catch {
    /*
     * Standard build fallback.
     */
    const pdfjs =
      await import(
        "pdfjs-dist"
      );

    try {
      const worker =
        await import(
          "pdfjs-dist/build/pdf.worker.min.mjs?url"
        );

      if (
        pdfjs.GlobalWorkerOptions &&
        typeof worker.default ===
          "string"
      ) {
        pdfjs.GlobalWorkerOptions.workerSrc =
          worker.default;
      }
    } catch {
      /*
       * Keep loading path alive.
       */
    }

    return pdfjs;
  }
}

/* ========================================================================== *
 * PDF TEXT TYPES
 * ========================================================================== */

type PdfTextItem = {
  str?: string;
  transform?: number[];
};

type PdfPageExtraction = {
  pageNumber:
    number;

  rows:
    Row[];

  text:
    string;

  characterCount:
    number;

  datedRows:
    number;

  paymentRows:
    number;

  numericRows:
    number;

  suspicious:
    boolean;
};

/* ========================================================================== *
 * SAFE PDF ITEM CONVERSION
 *
 * Do not blindly use "for...of" on PDF.js output.
 * Some browser/runtime combinations may return array-like structures.
 * ========================================================================== */

function coercePdfItems(
  value:
    unknown,
): PdfTextItem[] {
  if (
    Array.isArray(
      value,
    )
  ) {
    return value as
      PdfTextItem[];
  }

  if (
    value &&
    typeof value ===
      "object"
  ) {
    const iterator =
      (
        value as {
          [Symbol.iterator]?:
            unknown;
        }
      )[
        Symbol.iterator
      ];

    if (
      typeof iterator ===
      "function"
    ) {
      try {
        return Array.from(
          value as Iterable<PdfTextItem>,
        );
      } catch {
        return [];
      }
    }
  }

  return [];
}

/* ========================================================================== *
 * PDF VISUAL ROW EXTRACTION
 * ========================================================================== */

function groupPdfItems(
  itemsValue:
    unknown,
): Row[] {
  const items =
    coercePdfItems(
      itemsValue,
    );

  const buckets =
    new Map<
      number,
      Array<{
        x: number;
        text: string;
      }>
    >();

  /*
   * Index loop is deliberate.
   * Avoids relying on unknown iterable behavior from PDF.js internals.
   */
  for (
    let index = 0;
    index <
    items.length;
    index++
  ) {
    const item =
      items[index];

    if (
      !item?.str ||
      !Array.isArray(
        item.transform,
      )
    ) {
      continue;
    }

    const text =
      normalizeText(
        item.str,
      );

    if (
      !text
    ) {
      continue;
    }

    const x =
      Number(
        item.transform[4] ??
        0,
      );

    const y =
      Number(
        item.transform[5] ??
        0,
      );

    const key =
      Math.round(
        y /
        2.5,
      ) *
      2.5;

    const bucket =
      buckets.get(
        key,
      ) ??
      [];

    bucket.push({
      x,
      text,
    });

    buckets.set(
      key,
      bucket,
    );
  }

  return Array.from(
    buckets.entries(),
  )
    .sort(
      (
        a,
        b,
      ) =>
        b[0] -
        a[0],
    )
    .map(
      (
        [
          ,
          row,
        ],
      ) =>
        row
          .sort(
            (
              a,
              b,
            ) =>
              a.x -
              b.x,
          )
          .map(
            (
              item,
            ) =>
              normalizeText(
                item.text,
              ),
          )
          .filter(
            Boolean,
          ),
    )
    .filter(
      (
        row,
      ) =>
        row.length >
        0,
    );
}

function rowsToText(
  rows:
    Row[],
): string {
  return rows
    .map(
      (
        row,
      ) =>
        row.join(
          " ",
        ),
    )
    .join(
      "\n",
    );
}

/* ========================================================================== *
 * PDF QUALITY
 * ========================================================================== */

const DATE_SIGNAL =
  /\b(?:\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/\s][A-Za-z]{3,9}[-/\s]\d{2,4})\b/;

const PAYMENT_SIGNAL =
  /\b(?:UPI|IMPS|NEFT|RTGS|IBNEFT|IBRTGS|ENEFT|ERTGS|BHIM|P2A|P2P|TRTR)\b/i;

const MONEY_SIGNAL =
  /(?:₹\s*)?(?:\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{1,2})/;

function evaluatePdfPage(
  pageNumber:
    number,
  rows:
    Row[],
): PdfPageExtraction {
  const text =
    rowsToText(
      rows,
    );

  const characterCount =
    text
      .replace(
        /\s/g,
        "",
      )
      .length;

  let datedRows =
    0;

  let paymentRows =
    0;

  let numericRows =
    0;

  for (
    const row of rows
  ) {
    const line =
      row.join(
        " ",
      );

    if (
      DATE_SIGNAL.test(
        line,
      )
    ) {
      datedRows++;
    }

    if (
      PAYMENT_SIGNAL.test(
        line,
      )
    ) {
      paymentRows++;
    }

    if (
      MONEY_SIGNAL.test(
        line,
      )
    ) {
      numericRows++;
    }
  }

  const suspicious =
    characterCount <
      180 ||
    (
      datedRows >=
        2 &&
      numericRows ===
        0
    ) ||
    (
      paymentRows >=
        2 &&
      datedRows ===
        0
    ) ||
    (
      datedRows >=
        3 &&
      rows.length <
        5
    );

  return {
    pageNumber,
    rows,
    text,
    characterCount,
    datedRows,
    paymentRows,
    numericRows,
    suspicious,
  };
}

/* ========================================================================== *
 * PDF PAGE EXTRACTION
 * ========================================================================== */

async function extractPdfPages(
  doc:
    any,
): Promise<PdfPageExtraction[]> {
  const pages:
    PdfPageExtraction[] = [];

  const pageCount =
    Number(
      doc?.numPages ??
      0,
    );

  for (
    let pageNumber =
      1;
    pageNumber <=
    pageCount;
    pageNumber++
  ) {
    try {
      const page =
        await doc.getPage(
          pageNumber,
        );

      const content =
        await page.getTextContent();

      const rows =
        groupPdfItems(
          content?.items,
        );

      pages.push(
        evaluatePdfPage(
          pageNumber,
          rows,
        ),
      );
    } catch {
      /*
       * A single broken native text page should not destroy
       * the complete PDF.
       *
       * Empty page will automatically be considered suspicious
       * and sent through OCR recovery.
       */
      pages.push(
        evaluatePdfPage(
          pageNumber,
          [],
        ),
      );
    }
  }

  return pages;
}

/* ========================================================================== *
 * PDF PAGE -> IMAGE
 * ========================================================================== */

async function pageToDataUrl(
  doc:
    any,
  pageNumber:
    number,
): Promise<string> {
  const page =
    await doc.getPage(
      pageNumber,
    );

  const base =
    page.getViewport({
      scale:
        1,
    });

  const targetWidth =
    Math.min(
      Math.max(
        base.width *
        2.2,
        1600,
      ),
      2400,
    );

  const viewport =
    page.getViewport({
      scale:
        targetWidth /
        base.width,
    });

  const canvas =
    document.createElement(
      "canvas",
    );

  canvas.width =
    Math.round(
      viewport.width,
    );

  canvas.height =
    Math.round(
      viewport.height,
    );

  const context =
    canvas.getContext(
      "2d",
    );

  if (
    !context
  ) {
    throw new Error(
      "Could not render this PDF page.",
    );
  }

  await page.render({
    canvasContext:
      context,

    viewport,

    canvas,
  }).promise;

  return canvas.toDataURL(
    "image/jpeg",
    0.92,
  );
}

/* ========================================================================== *
 * IMAGE FILE -> DATA URL
 * ========================================================================== */

async function fileToDataUrl(
  file:
    File,
): Promise<string> {
  return await new Promise<
    string
  >(
    (
      resolve,
      reject,
    ) => {
      const reader =
        new FileReader();

      reader.onload =
        () =>
          resolve(
            String(
              reader.result ??
              "",
            ),
          );

      reader.onerror =
        () =>
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

/* ========================================================================== *
 * OCR
 * ========================================================================== */

async function ocrImages(
  images:
    string[],
): Promise<string> {
  if (
    images.length ===
    0
  ) {
    return "";
  }

  const result =
    await ocrStatementPages({
      data: {
        images,
      },
    });

  return String(
    result.text ??
    "",
  );
}

type OcrBatchResult = {
  texts:
    string[];

  failedPages:
    number[];
};

async function ocrPdfPages(
  doc:
    any,
  pages:
    number[],
  onProgress?:
    ExtractProgress,
): Promise<OcrBatchResult> {
  const unique =
    Array.from(
      new Set(
        pages,
      ),
    )
      .filter(
        (
          page,
        ) =>
          page >=
            1 &&
          page <=
            Number(
              doc?.numPages ??
              0,
            ),
      )
      .sort(
        (
          a,
          b,
        ) =>
          a -
          b,
      );

  const texts:
    string[] = [];

  const failedPages:
    number[] = [];

  const BATCH_SIZE =
    4;

  for (
    let start = 0;
    start <
    unique.length;
    start +=
      BATCH_SIZE
  ) {
    const batch =
      unique.slice(
        start,
        start +
        BATCH_SIZE,
      );

    onProgress?.(
      `Deep reading PDF pages ${start + 1}-${Math.min(
        start +
        batch.length,
        unique.length,
      )} of ${unique.length}…`,
    );

    const images:
      string[] = [];

    const renderedPages:
      number[] = [];

    for (
      const pageNumber of
      batch
    ) {
      try {
        images.push(
          await pageToDataUrl(
            doc,
            pageNumber,
          ),
        );

        renderedPages.push(
          pageNumber,
        );
      } catch {
        failedPages.push(
          pageNumber,
        );
      }
    }

    if (
      images.length ===
      0
    ) {
      continue;
    }

    try {
      const text =
        await ocrImages(
          images,
        );

      if (
        text.trim()
      ) {
        texts.push(
          text,
        );
      } else {
        failedPages.push(
          ...renderedPages,
        );
      }
    } catch {
      failedPages.push(
        ...renderedPages,
      );
    }
  }

  return {
    texts,

    failedPages:
      Array.from(
        new Set(
          failedPages,
        ),
      ).sort(
        (
          a,
          b,
        ) =>
          a -
          b,
      ),
  };
}

/* ========================================================================== *
 * CORE QUALITY
 * ========================================================================== */

function knownTransactionCount(
  core:
    CoreResult,
): number {
  return core.transactions
    .filter(
      (
        transaction,
      ) =>
        transaction.direction !==
          "unknown" &&
        transaction.amount !==
          null,
    )
    .length;
}

function betterCore(
  first:
    CoreResult,
  second:
    CoreResult,
): CoreResult {
  const firstKnown =
    knownTransactionCount(
      first,
    );

  const secondKnown =
    knownTransactionCount(
      second,
    );

  if (
    secondKnown >
    firstKnown
  ) {
    return second;
  }

  if (
    firstKnown >
    secondKnown
  ) {
    return first;
  }

  return second.transactions
    .length >
    first.transactions
      .length
    ? second
    : first;
}

function pageNeedsOcr(
  page:
    PdfPageExtraction,
  pageCore:
    CoreResult,
): boolean {
  if (
    page.suspicious
  ) {
    return true;
  }

  const known =
    knownTransactionCount(
      pageCore,
    );

  if (
    page.datedRows >=
      4 &&
    known <
      Math.max(
        1,
        Math.floor(
          page.datedRows *
          0.45,
        ),
      )
  ) {
    return true;
  }

  if (
    page.paymentRows >=
      3 &&
    known ===
      0
  ) {
    return true;
  }

  if (
    page.datedRows >=
      2 &&
    known ===
      0
  ) {
    return true;
  }

  return false;
}

/* ========================================================================== *
 * PDF READER
 * ========================================================================== */

async function readPdf(
  file:
    File,
  onProgress?:
    ExtractProgress,
): Promise<CombinedResult> {
  onProgress?.(
    "Opening PDF…",
  );

  let pdfjs:
    any;

  try {
    pdfjs =
      await loadPdfjs();
  } catch {
    throw new Error(
      "PDF reader could not be loaded on this browser.",
    );
  }

  let doc:
    any;

  try {
    /*
     * Explicit Uint8Array is safer than handing PDF.js
     * a browser-specific ArrayBuffer object directly.
     */
    const bytes =
      new Uint8Array(
        await file.arrayBuffer(),
      );

    const loadingTask =
      pdfjs.getDocument({
        data:
          bytes,
      });

    doc =
      await loadingTask.promise;
  } catch (
    error
  ) {
    const message =
      error instanceof Error
        ? error.message
        : "";

    if (
      /password/i.test(
        message,
      )
    ) {
      throw new Error(
        "This PDF is password protected. Please upload an unlocked bank statement.",
      );
    }

    throw new Error(
      "Unable to open this PDF. The file may be encrypted, corrupted, or unsupported by the browser PDF engine.",
    );
  }

  onProgress?.(
    `Reading ${Number(
      doc?.numPages ??
      0,
    )} PDF page(s)…`,
  );

  const pages =
    await extractPdfPages(
      doc,
    );

  /*
   * ---------------------------------------------------------------
   * WHOLE-DOCUMENT STRUCTURED PARSE
   * ---------------------------------------------------------------
   */

  const allRows =
    pages.flatMap(
      (
        page,
      ) =>
        page.rows,
    );

  const detectedColumns =
    findColumns(
      allRows,
    ).columns;

  /*
   * Repair malformed Withdrawals / Deposits / Balance structure
   * before statement-core sees it.
   */
  const repairedRows =
    repairShiftedAmountBalanceRows(
      allRows,
      detectedColumns,
    );

  const structuredCore =
    parseStatementRows(
      repairedRows,
      detectedColumns,
    );

  /*
   * ---------------------------------------------------------------
   * WHOLE-DOCUMENT FLAT-TEXT FALLBACK
   *
   * Some PDFs have usable visual text but their x-position structure
   * does not map cleanly to table cells.
   * ---------------------------------------------------------------
   */

  const fullText =
    pages
      .map(
        (
          page,
        ) =>
          page.text,
      )
      .filter(
        Boolean,
      )
      .join(
        "\n",
      );

  const textCore =
    fullText.trim()
      ? parseStatementText(
          fullText,
        )
      : structuredCore;

  /*
   * Pick the stronger native interpretation.
   */
  const nativeCore =
    betterCore(
      structuredCore,
      textCore,
    );

  /* ---------------------------------------------------------------------- *
   * PAGE LEVEL QUALITY CHECK
   * ---------------------------------------------------------------------- */

  const ocrPages:
    number[] = [];

  let inheritedColumns:
    ColumnMap | null =
    detectedColumns;

  for (
    const page of pages
  ) {
    const repairedPageRows =
      repairShiftedAmountBalanceRows(
        page.rows,
        inheritedColumns,
      );

    const structuredPageCore =
      parseStatementRows(
        repairedPageRows,
        inheritedColumns,
      );

    const textPageCore =
      page.text.trim()
        ? parseStatementText(
            page.text,
          )
        : structuredPageCore;

    const pageCore =
      betterCore(
        structuredPageCore,
        textPageCore,
      );

    if (
      pageCore.columns !==
      null
    ) {
      inheritedColumns =
        pageCore.columns;
    }

    if (
      pageNeedsOcr(
        page,
        pageCore,
      )
    ) {
      ocrPages.push(
        page.pageNumber,
      );
    }
  }

  /*
   * No native transactions at all:
   * OCR every page.
   */
  if (
    knownTransactionCount(
      nativeCore,
    ) ===
    0
  ) {
    for (
      let page = 1;
      page <=
      Number(
        doc?.numPages ??
        0,
      );
      page++
    ) {
      ocrPages.push(
        page,
      );
    }
  }

  /*
   * Official summary mismatch:
   * re-check pages that visibly contain transaction data.
   */
  if (
    nativeCore.warnings
      .length >
    0
  ) {
    for (
      const page of pages
    ) {
      if (
        page.datedRows >
          0 ||
        page.paymentRows >
          0
      ) {
        ocrPages.push(
          page.pageNumber,
        );
      }
    }
  }

  const uniqueOcrPages =
    Array.from(
      new Set(
        ocrPages,
      ),
    );

  /*
   * Clean native statement.
   */
  if (
    uniqueOcrPages.length ===
    0
  ) {
    return combinedFromCore(
      nativeCore,
      repairedRows.length,
    );
  }

  onProgress?.(
    `${uniqueOcrPages.length} PDF page(s) need deeper reading…`,
  );

  const ocrResult =
    await ocrPdfPages(
      doc,
      uniqueOcrPages,
      onProgress,
    );

  /*
   * If OCR fails but native PDF already gave valid transactions,
   * DO NOT throw away usable native results.
   */
  if (
    ocrResult.texts.length ===
      0 &&
    ocrResult.failedPages.length >
      0
  ) {
    if (
      knownTransactionCount(
        nativeCore,
      ) >
      0
    ) {
      return combinedFromCore(
        nativeCore,
        repairedRows.length,
        [
          `OCR could not verify PDF page(s): ${ocrResult.failedPages.join(
            ", ",
          )}. Native PDF text was used for the available result.`,
        ],
      );
    }

    throw new Error(
      `The PDF opened, but ${ocrResult.failedPages.length} page(s) required deeper reading and OCR failed.`,
    );
  }

  /*
   * OCR is recovery.
   *
   * Keep native result unless an OCR interpretation is demonstrably
   * stronger than it.
   */
  let finalCore =
    nativeCore;

  for (
    const text of
    ocrResult.texts
  ) {
    if (
      !text.trim()
    ) {
      continue;
    }

    finalCore =
      betterCore(
        finalCore,
        parseStatementText(
          text,
        ),
      );
  }

  const warnings:
    string[] = [];

  if (
    ocrResult.failedPages.length >
    0
  ) {
    warnings.push(
      `OCR could not verify PDF page(s): ${ocrResult.failedPages.join(
        ", ",
      )}. Results for those pages rely on native PDF text.`,
    );
  }

  return combinedFromCore(
    finalCore,
    repairedRows.length,
    warnings,
  );
}

/* ========================================================================== *
 * SPREADSHEET
 * ========================================================================== */

type WorkbookSheet = {
  name:
    string;

  rows:
    Row[];
};

/* ========================================================================== *
 * EXCEL CELL NORMALIZATION
 * ========================================================================== */

function excelCellText(
  value:
    unknown,
): string {
  /*
   * Defensive support if SheetJS ever gives us a Date object.
   */
  if (
    value instanceof
      Date &&
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
        value.getMonth() +
        1,
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
  file:
    File,
): Promise<WorkbookSheet[]> {
  const XLSX =
    await import(
      "xlsx"
    );

  const workbook =
    XLSX.read(
      await file.arrayBuffer(),
      {
        type:
          "array",

        /*
         * Keep bank-formatted displayed values.
         */
        raw:
          false,

        cellDates:
          false,
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

    if (
      !sheet
    ) {
      continue;
    }

    const data =
      XLSX.utils.sheet_to_json(
        sheet,
        {
          header:
            1,

          defval:
            "",

          raw:
            false,

          blankrows:
            false,
        },
      ) as unknown[][];

    const rows:
      Row[] =
      data
        .map(
          (
            rawRow:
              unknown[],
          ) =>
            rawRow.map(
              excelCellText,
            ),
        )
        .filter(
          (
            row:
              Row,
          ) =>
            row.some(
              Boolean,
            ),
        );

    if (
      rows.length >
      0
    ) {
      sheets.push({
        name:
          sheetName,

        rows,
      });
    }
  }

  return sheets;
}

/* ========================================================================== *
 * WORKBOOK SHEET GROUPING
 * ========================================================================== */

function columnSignature(
  columns:
    ColumnMap | null,
): string {
  if (
    columns ===
    null
  ) {
    return "";
  }

  return [
    columns.serial,
    columns.date,
    columns.valueDate,
    columns.narration,
    columns.reference,
    columns.debit,
    columns.credit,
    columns.amount,
    columns.type,
    columns.balance,
    columns.balanceType,
    columns.channel,
  ]
    .map(
      (
        value,
      ) =>
        value ===
        undefined
          ? "-"
          : String(
              value,
            ),
    )
    .join(
      "|",
    );
}

type SheetGroup = {
  rows:
    Row[];

  columns:
    ColumnMap | null;
};

function groupWorkbookSheets(
  sheets:
    WorkbookSheet[],
): SheetGroup[] {
  const groups:
    SheetGroup[] = [];

  let currentRows:
    Row[] = [];

  let currentColumns:
    ColumnMap | null =
    null;

  let currentSignature =
    "";

  const flush =
    () => {
      if (
        currentRows.length ===
        0
      ) {
        return;
      }

      groups.push({
        rows:
          currentRows,

        columns:
          currentColumns,
      });

      currentRows =
        [];

      currentColumns =
        null;

      currentSignature =
        "";
    };

  for (
    const sheet of sheets
  ) {
    const detected =
      findColumns(
        sheet.rows,
      ).columns;

    const signature =
      columnSignature(
        detected,
      );

    /*
     * First sheet.
     */
    if (
      currentRows.length ===
      0
    ) {
      currentRows =
        [
          ...sheet.rows,
        ];

      currentColumns =
        detected;

      currentSignature =
        signature;

      continue;
    }

    /*
     * Sheet without its own header:
     * continuation of previous statement table.
     */
    if (
      detected ===
      null
    ) {
      currentRows.push(
        ...sheet.rows,
      );

      continue;
    }

    /*
     * Previous sheet had no detectable header,
     * but this sheet does.
     */
    if (
      currentColumns ===
      null
    ) {
      currentRows.push(
        ...sheet.rows,
      );

      currentColumns =
        detected;

      currentSignature =
        signature;

      continue;
    }

    /*
     * Same layout:
     * continue same table and preserve balance chain.
     */
    if (
      signature ===
      currentSignature
    ) {
      currentRows.push(
        ...sheet.rows,
      );

      continue;
    }

    /*
     * Different table structure:
     * start separate group.
     */
    flush();

    currentRows =
      [
        ...sheet.rows,
      ];

    currentColumns =
      detected;

    currentSignature =
      signature;
  }

  flush();

  return groups;
}

/* ========================================================================== *
 * WORKBOOK PARSER
 * ========================================================================== */

function parseWorkbook(
  sheets:
    WorkbookSheet[],
  onProgress?:
    ExtractProgress,
): CombinedResult {
  if (
    sheets.length ===
    0
  ) {
    return emptyCombined();
  }

  const groups =
    groupWorkbookSheets(
      sheets,
    );

  const combined:
    CombinedResult[] = [];

  for (
    let index = 0;
    index <
    groups.length;
    index++
  ) {
    const group =
      groups[index];

    if (
      !group
    ) {
      continue;
    }

    onProgress?.(
      `Reading statement table ${index + 1} of ${groups.length}…`,
    );

    /*
     * Fix malformed bank export BEFORE parser.
     *
     * Correct normal XLS/XLSX rows are untouched.
     */
    const repairedRows =
      repairShiftedAmountBalanceRows(
        group.rows,
        group.columns,
      );

    const core =
      parseStatementRows(
        repairedRows,
        group.columns,
      );

    combined.push(
      combinedFromCore(
        core,
        repairedRows.length,
      ),
    );
  }

  return mergeCombined(
    combined,
  );
}

/* ========================================================================== *
 * MAIN FILE READER
 * ========================================================================== */

export async function extractFromFile(
  file:
    File,
  onProgress?:
    ExtractProgress,
): Promise<CombinedResult> {
  const name =
    file.name
      .toLowerCase();

  const type =
    file.type
      .toLowerCase();

  /* ------------------------------------------------------------------------ *
   * IMAGE
   * ------------------------------------------------------------------------ */

  const isImage =
    type.startsWith(
      "image/",
    ) ||
    /\.(jpg|jpeg|png|webp|bmp|tif|tiff)$/i.test(
      name,
    );

  if (
    isImage
  ) {
    onProgress?.(
      "Reading scanned statement image…",
    );

    const image =
      await fileToDataUrl(
        file,
      );

    let text =
      "";

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

  /* ------------------------------------------------------------------------ *
   * PDF
   * ------------------------------------------------------------------------ */

  if (
    name.endsWith(
      ".pdf",
    ) ||
    type ===
      "application/pdf"
  ) {
    return await readPdf(
      file,
      onProgress,
    );
  }

  /* ------------------------------------------------------------------------ *
   * XLS / XLSX / CSV
   * ------------------------------------------------------------------------ */

  if (
    /\.(xls|xlsx|csv)$/i.test(
      name,
    ) ||
    type ===
      "text/csv" ||
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
      sheets.length ===
      0
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

  /* ------------------------------------------------------------------------ *
   * TXT / TEXT / OTHER BANK EXPORT
   * ------------------------------------------------------------------------ */

  onProgress?.(
    "Reading text statement…",
  );

  let text:
    string;

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
