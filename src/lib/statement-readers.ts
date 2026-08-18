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
  mergeCoreResults,
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

  /*
   * Reader-level warnings.
   *
   * Example:
   * - OCR failed on some suspicious pages
   * - official summary mismatch
   *
   * Existing UI may ignore this for now,
   * but next we will display it in index.tsx.
   */
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
    )
  ) {
    return null;
  }

  if (
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
    )
  ) {
    return null;
  }

  if (
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
 * PUBLIC ROW DEDUPE
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
     * Missing-reference rows are NOT aggressively deduplicated.
     *
     * Same date + same amount can legitimately occur multiple times.
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
  transaction: CoreTransaction,
  accepted: boolean,
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
  transaction: CoreTransaction,
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
   * exactOptionalPropertyTypes-safe.
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
 * CORE -> COMBINED RESULT
 * ========================================================================== */

function combinedFromCore(
  core: CoreResult,
  inputLines = 0,
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

    warnings:
      [
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
  list: CombinedResult[],
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

  const warnings =
    [
      ...new Set(
        list.flatMap(
          (
            result,
          ) =>
            result.warnings,
        ),
      ),
    ];

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

    warnings,
  };
}

/* ========================================================================== *
 * TEXT
 * ========================================================================== */

function fromText(
  text: string,
  extraWarnings:
    string[] = [],
): CombinedResult {
  const normalized =
    String(
      text ?? "",
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
 * PDF.JS
 * ========================================================================== */

async function loadPdfjs() {
  const pdfjs =
    await import(
      "pdfjs-dist"
    );

  const workerSrc =
    (
      await import(
        "pdfjs-dist/build/pdf.worker.min.mjs?url"
      )
    ).default;

  pdfjs.GlobalWorkerOptions.workerSrc =
    workerSrc;

  return pdfjs;
}

/* ========================================================================== *
 * PDF VISUAL ROWS
 * ========================================================================== */

type PdfTextItem = {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
};

type PdfPageExtraction = {
  pageNumber: number;
  rows: Row[];
  text: string;
  characterCount: number;
  datedRows: number;
  paymentRows: number;
  numericRows: number;
  suspicious: boolean;
};

function groupPdfItems(
  items: PdfTextItem[],
): Row[] {
  const buckets =
    new Map<
      number,
      Array<{
        x: number;
        text: string;
      }>
    >();

  for (
    const item of items
  ) {
    if (
      !item.str ||
      !item.transform
    ) {
      continue;
    }

    const text =
      normalizeText(
        item.str,
      );

    if (!text) {
      continue;
    }

    const x =
      item.transform[4] ??
      0;

    const y =
      item.transform[5] ??
      0;

    /*
     * Small Y-coordinate differences can still belong
     * to the same printed transaction line.
     */
    const key =
      Math.round(
        y / 2.5,
      ) *
      2.5;

    const row =
      buckets.get(
        key,
      ) ?? [];

    row.push({
      x,
      text,
    });

    buckets.set(
      key,
      row,
    );
  }

  return [...buckets.entries()]
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
  rows: Row[],
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
 * PDF PAGE QUALITY
 * ========================================================================== */

const DATE_SIGNAL =
  /\b(?:\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/\s][A-Za-z]{3,9}[-/\s]\d{2,4})\b/;

const PAYMENT_SIGNAL =
  /\b(?:UPI|IMPS|NEFT|RTGS|IBNEFT|IBRTGS|ENEFT|ERTGS|BHIM|P2A|P2P|TRTR)\b/i;

const MONEY_SIGNAL =
  /(?:₹\s*)?(?:\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{1,2})/;

function evaluatePdfPage(
  pageNumber: number,
  rows: Row[],
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

  let datedRows = 0;
  let paymentRows = 0;
  let numericRows = 0;

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
    characterCount < 180 ||
    (
      datedRows >= 2 &&
      numericRows === 0
    ) ||
    (
      paymentRows >= 2 &&
      datedRows === 0
    ) ||
    (
      datedRows >= 3 &&
      rows.length < 5
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

async function extractPdfPages(
  doc: any,
): Promise<PdfPageExtraction[]> {
  const pages:
    PdfPageExtraction[] = [];

  for (
    let pageNumber = 1;
    pageNumber <=
    doc.numPages;
    pageNumber++
  ) {
    const page =
      await doc.getPage(
        pageNumber,
      );

    const content =
      await page.getTextContent();

    const rows =
      groupPdfItems(
        content.items as PdfTextItem[],
      );

    pages.push(
      evaluatePdfPage(
        pageNumber,
        rows,
      ),
    );
  }

  return pages;
}

/* ========================================================================== *
 * PDF IMAGE RENDERING
 * ========================================================================== */

async function pageToDataUrl(
  doc: any,
  pageNumber: number,
): Promise<string> {
  const page =
    await doc.getPage(
      pageNumber,
    );

  const base =
    page.getViewport({
      scale: 1,
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

  const scale =
    targetWidth /
    base.width;

  const viewport =
    page.getViewport({
      scale,
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

  if (!context) {
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
  file: File,
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
  images: string[],
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
  texts: string[];
  failedPages: number[];
};

/**
 * OCR in batches of 4.
 *
 * Server maximum is 12 images/request,
 * so 4 stays safely under the server limit.
 */
async function ocrPdfPages(
  doc: any,
  pages: number[],
  onProgress?: ExtractProgress,
): Promise<OcrBatchResult> {
  const unique =
    [
      ...new Set(
        pages,
      ),
    ]
      .filter(
        (
          page,
        ) =>
          page >= 1 &&
          page <=
            doc.numPages,
      )
      .sort(
        (
          a,
          b,
        ) =>
          a - b,
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
        const image =
          await pageToDataUrl(
            doc,
            pageNumber,
          );

        images.push(
          image,
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
      [
        ...new Set(
          failedPages,
        ),
      ].sort(
        (
          a,
          b,
        ) =>
          a - b,
      ),
  };
}

/* ========================================================================== *
 * PDF OCR DECISION
 * ========================================================================== */

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

  const knownTransactions =
    pageCore.transactions
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

  /*
   * Many visible dated rows but only a small portion became
   * usable transactions.
   */
  if (
    page.datedRows >= 4 &&
    knownTransactions <
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
    page.paymentRows >= 3 &&
    knownTransactions ===
      0
  ) {
    return true;
  }

  if (
    page.datedRows >= 2 &&
    knownTransactions ===
      0
  ) {
    return true;
  }

  return false;
}

/* ========================================================================== *
 * PDF
 *
 * CRITICAL DESIGN:
 *
 * FINAL native extraction parses ALL PDF rows together.
 *
 * Therefore:
 *
 * page 1 last balance <-> page 2 first transaction
 *
 * and
 *
 * page 2 last balance <-> page 3 first transaction
 *
 * remain in one chronological transaction chain.
 *
 * Page-level parsing below is ONLY used to decide whether OCR is needed.
 * ========================================================================== */

async function readPdf(
  file: File,
  onProgress?: ExtractProgress,
): Promise<CombinedResult> {
  onProgress?.(
    "Opening PDF…",
  );

  let pdfjs:
    Awaited<
      ReturnType<
        typeof loadPdfjs
      >
    >;

  try {
    pdfjs =
      await loadPdfjs();
  } catch {
    throw new Error(
      "PDF reader could not be loaded.",
    );
  }

  let doc:
    any;

  try {
    doc =
      await pdfjs.getDocument({
        data:
          await file.arrayBuffer(),
      }).promise;
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
      "Unable to open this PDF. The file may be encrypted, corrupted, or unsupported.",
    );
  }

  onProgress?.(
    `Reading ${doc.numPages} PDF page(s)…`,
  );

  const pages =
    await extractPdfPages(
      doc,
    );

  /*
   * ---------------------------------------------------------------
   * FINAL NATIVE PARSE
   * ---------------------------------------------------------------
   *
   * Entire PDF is parsed as ONE statement.
   *
   * This fixes cross-page running-balance classification.
   */
  const allNativeRows:
    Row[] =
    pages.flatMap(
      (
        page,
      ) =>
        page.rows,
    );

  const nativeCore =
    parseStatementRows(
      allNativeRows,
    );

  /*
   * ---------------------------------------------------------------
   * PAGE-LEVEL QUALITY CHECK
   * ---------------------------------------------------------------
   *
   * These page parses are NOT used as final transaction results.
   * They only decide which pages require OCR.
   */
  const ocrPages:
    number[] = [];

  let inheritedColumns:
    ColumnMap | null =
    nativeCore.columns;

  for (
    const page of pages
  ) {
    const pageCore =
      parseStatementRows(
        page.rows,
        inheritedColumns,
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

  const usableNative =
    nativeCore.transactions
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

  /*
   * Nothing usable from native PDF:
   * OCR every page.
   */
  if (
    usableNative ===
    0
  ) {
    for (
      let pageNumber = 1;
      pageNumber <=
      doc.numPages;
      pageNumber++
    ) {
      ocrPages.push(
        pageNumber,
      );
    }
  }

  /*
   * Official statement totals/counts disagree with extraction.
   *
   * Treat transaction-looking pages as suspicious.
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
    [
      ...new Set(
        ocrPages,
      ),
    ];

  /*
   * Clean native PDF.
   */
  if (
    uniqueOcrPages.length ===
    0
  ) {
    return combinedFromCore(
      nativeCore,
      allNativeRows.length,
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
   * OCR was required but completely unavailable.
   *
   * Never silently pretend native partial extraction is complete.
   */
  if (
    ocrResult.texts.length ===
      0 &&
    ocrResult.failedPages.length >
      0
  ) {
    throw new Error(
      `The PDF opened, but ${ocrResult.failedPages.length} page(s) required deeper reading and OCR failed. Check OCR configuration or try the statement again.`,
    );
  }

  /*
   * OCR texts are normalized statement rows.
   *
   * Each OCR text may contain multiple pages from one batch.
   */
  const ocrCores =
    ocrResult.texts
      .filter(
        (
          text,
        ) =>
          Boolean(
            text.trim(),
          ),
      )
      .map(
        (
          text,
        ) =>
          parseStatementText(
            text,
          ),
      );

  /*
   * Native extraction remains primary.
   *
   * OCR adds/replaces higher-quality duplicate transactions through
   * mergeCoreResults().
   */
  const finalCore =
    mergeCoreResults([
      nativeCore,
      ...ocrCores,
    ]);

  const warnings:
    string[] = [];

  if (
    ocrResult.failedPages.length >
    0
  ) {
    warnings.push(
      `OCR could not verify PDF page(s): ${ocrResult.failedPages.join(
        ", ",
      )}. Results from those page(s) may rely only on the native PDF text layer.`,
    );
  }

  return combinedFromCore(
    finalCore,
    allNativeRows.length,
    warnings,
  );
}

/* ========================================================================== *
 * SPREADSHEET
 * ========================================================================== */

type WorkbookSheet = {
  name: string;
  rows: Row[];
};

async function readWorkbookSheets(
  file: File,
): Promise<WorkbookSheet[]> {
  const XLSX =
    await import(
      "xlsx"
    );

  const buffer =
    await file.arrayBuffer();

  const workbook =
    XLSX.read(
      buffer,
      {
        type:
          "array",

        /*
         * Preserve displayed bank statement values.
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

    if (!sheet) {
      continue;
    }

    const data =
      XLSX.utils
        .sheet_to_json<
          unknown[]
        >(
          sheet,
          {
            header: 1,
            defval: "",
            raw: false,
            blankrows:
              false,
          },
        );

    const rows:
      Row[] =
      data
        .map(
          (
            rawRow,
          ) =>
            (
              rawRow as unknown[]
            )
              .map(
                (
                  cell,
                ) =>
                  normalizeText(
                    cell,
                  ),
              ),
        )
        .filter(
          (
            row,
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
 * COLUMN SIGNATURE
 *
 * Used to know whether Sheet 2 is a continuation of Sheet 1
 * or starts a genuinely different table layout.
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
    .join("|");
}

type SheetGroup = {
  rows: Row[];
  columns: ColumnMap | null;
};

/**
 * Group continuation sheets together.
 *
 * Example:
 *
 * Sheet1:
 * Date | Narration | Debit | Credit | Balance
 *
 * Sheet2:
 * transactions continue without another header
 *
 * => parsed together so balance chain survives sheet boundary.
 *
 * If a later sheet has a genuinely different detected table layout,
 * previous group is closed and a new group starts.
 */
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

  const flush = () => {
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

    const detectedSignature =
      columnSignature(
        detected,
      );

    /*
     * First sheet/group.
     */
    if (
      currentRows.length ===
      0
    ) {
      currentRows =
        [...sheet.rows];

      currentColumns =
        detected;

      currentSignature =
        detectedSignature;

      continue;
    }

    /*
     * No header on this sheet:
     * treat as continuation of previous sheet.
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
     * Current group did not have a detected header yet.
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
        detectedSignature;

      continue;
    }

    /*
     * Same column layout:
     * continuation of same bank table.
     *
     * Parse together for cross-sheet balance continuity.
     */
    if (
      detectedSignature ===
      currentSignature
    ) {
      currentRows.push(
        ...sheet.rows,
      );

      continue;
    }

    /*
     * Different table structure:
     * safely start a separate parser group.
     */
    flush();

    currentRows =
      [...sheet.rows];

    currentColumns =
      detected;

    currentSignature =
      detectedSignature;
  }

  flush();

  return groups;
}

/* ========================================================================== *
 * SPREADSHEET PARSER
 * ========================================================================== */

function parseWorkbook(
  sheets:
    WorkbookSheet[],
  onProgress?: ExtractProgress,
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

  const cores:
    CoreResult[] = [];

  let inputLines = 0;

  for (
    let index = 0;
    index <
    groups.length;
    index++
  ) {
    const group =
      groups[index];

    if (!group) {
      continue;
    }

    onProgress?.(
      `Reading statement table ${index + 1} of ${groups.length}…`,
    );

    inputLines +=
      group.rows.length;

    /*
     * Entire continuation group is parsed together.
     *
     * This preserves running-balance direction across sheet boundaries.
     */
    const core =
      parseStatementRows(
        group.rows,
        group.columns,
      );

    cores.push(
      core,
    );
  }

  const merged =
    mergeCoreResults(
      cores,
    );

  return combinedFromCore(
    merged,
    inputLines,
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

    let text:
      string;

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
   * TXT / TEXT / OTHER PLAIN BANK EXPORT
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
