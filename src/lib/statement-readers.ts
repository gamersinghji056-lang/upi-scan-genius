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
   * Reader warnings are available for future UI display.
   *
   * Existing UI can safely ignore this property.
   */
  warnings: string[];
};

export type ExtractProgress = (
  stage: string,
) => void;

/* ========================================================================== *
 * CORE -> PUBLIC RESULT
 *
 * IMPORTANT:
 *
 * The reader now converts CoreResult DIRECTLY into the public
 * Credit/Debit result.
 *
 * We do NOT parse the same rows again through separate parser passes.
 *
 * This is critical for:
 * - inherited spreadsheet headers
 * - inherited PDF page headers
 * - native + OCR merging
 * - consistent debit/credit classification
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
     * Never aggressively dedupe N/A transactions.
     *
     * Two genuine same-date/same-amount UPI credits can exist.
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

  const diagnostic:
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

  if (
    reason !==
    undefined
  ) {
    diagnostic.reason =
      reason;
  }

  return diagnostic;
}

/* ========================================================================== *
 * CORE RESULT -> COMBINED RESULT
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
        core.transactions.length,

      upiRows:
        core.transactions.filter(
          (
            transaction,
          ) =>
            transaction.mode ===
            "UPI",
        ).length,

      rowsWithReference:
        core.transactions.filter(
          (
            transaction,
          ) =>
            Boolean(
              transaction.reference,
            ),
        ).length,

      creditRows:
        core.transactions.filter(
          (
            transaction,
          ) =>
            transaction.direction ===
            "credit",
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
        ...core.warnings,
        ...extraWarnings,
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
 * PUBLIC MERGE
 *
 * Used when multiple files are uploaded by UI.
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

  const diagnosticRows =
    list.flatMap(
      (
        result,
      ) =>
        result.credit
          .debug.rows,
    );

  const columns =
    list.find(
      (
        result,
      ) =>
        result.credit.debug
          .columns !==
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
                .debug
                .inputLines,
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
                .debug
                .upiRows,
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
                .debug
                .creditRows,
            0,
          ),

        accepted:
          credits.length,

        columns,

        rows:
          diagnosticRows,
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
      ).length;

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
 * PDF VISUAL EXTRACTION
 * ========================================================================== */

type PdfTextItem = {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
};

type PdfPageExtraction = {
  pageNumber: number;
  text: string;
  rows: Row[];
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

    const key =
      Math.round(
        y / 2.5,
      ) * 2.5;

    const current =
      buckets.get(
        key,
      ) ?? [];

    current.push({
      x,
      text,
    });

    buckets.set(
      key,
      current,
    );
  }

  const rows:
    Row[] = [];

  const sortedRows =
    [...buckets.entries()]
      .sort(
        (
          a,
          b,
        ) =>
          b[0] -
          a[0],
      );

  for (
    const [
      ,
      itemsOnRow,
    ] of sortedRows
  ) {
    const ordered =
      itemsOnRow.sort(
        (
          a,
          b,
        ) =>
          a.x -
          b.x,
      );

    const row =
      ordered
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
        );

    if (
      row.length
    ) {
      rows.push(
        row,
      );
    }
  }

  return rows;
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
 * PDF QUALITY CHECK
 * ========================================================================== */

const DATE_SIGNAL =
  /\b(?:\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/\s][A-Za-z]{3,9}[-/\s]\d{2,4})\b/;

const PAYMENT_SIGNAL =
  /\b(?:UPI|IMPS|NEFT|RTGS|IBNEFT|IBRTGS|BHIM|P2A|TRTR)\b/i;

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
    text,
    rows,
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
  const output:
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

    output.push(
      evaluatePdfPage(
        pageNumber,
        rows,
      ),
    );
  }

  return output;
}

/* ========================================================================== *
 * PDF PAGE -> IMAGE
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
 * FILE IMAGE -> DATA URL
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

type OcrReadResult = {
  texts: string[];
  failedPages: number[];
};

/**
 * OCR runs in batches of 4.
 *
 * Server currently accepts up to 12 images per call,
 * therefore batch size 4 stays comfortably inside the limit.
 */
async function ocrPdfPages(
  doc: any,
  pages: number[],
  onProgress?: ExtractProgress,
): Promise<OcrReadResult> {
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

  const OCR_BATCH =
    4;

  for (
    let start = 0;
    start <
    unique.length;
    start +=
      OCR_BATCH
  ) {
    const batch =
      unique.slice(
        start,
        start +
          OCR_BATCH,
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
 * PDF NATIVE CORE
 * ========================================================================== */

type NativePageResult = {
  page: PdfPageExtraction;
  core: CoreResult;
};

function parseNativePage(
  page: PdfPageExtraction,
  inheritedColumns:
    ColumnMap | null,
): NativePageResult {
  const core =
    parseStatementRows(
      page.rows,
      inheritedColumns,
    );

  return {
    page,
    core,
  };
}

function shouldOcrPage(
  result: NativePageResult,
): boolean {
  const {
    page,
    core,
  } =
    result;

  if (
    page.suspicious
  ) {
    return true;
  }

  const knownTransactions =
    core.transactions.filter(
      (
        transaction,
      ) =>
        transaction.direction !==
          "unknown" &&
        transaction.amount !==
          null,
    ).length;

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

  const nativeResults:
    NativePageResult[] = [];

  let inheritedColumns:
    ColumnMap | null =
    null;

  for (
    const page of pages
  ) {
    const result =
      parseNativePage(
        page,
        inheritedColumns,
      );

    nativeResults.push(
      result,
    );

    if (
      result.core.columns !==
      null
    ) {
      inheritedColumns =
        result.core.columns;
    }
  }

  const nativeCores =
    nativeResults.map(
      (
        result,
      ) =>
        result.core,
    );

  const mergedNativeCore =
    mergeCoreResults(
      nativeCores,
    );

  const ocrPages:
    number[] = [];

  for (
    const result of
      nativeResults
  ) {
    if (
      shouldOcrPage(
        result,
      )
    ) {
      ocrPages.push(
        result.page
          .pageNumber,
      );
    }
  }

  /*
   * Nothing recovered natively:
   * OCR every PDF page.
   */
  const usableNativeCount =
    mergedNativeCore
      .transactions
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

  if (
    usableNativeCount ===
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
   * Official summary mismatch is strong evidence that
   * native extraction may have missed rows.
   */
  if (
    mergedNativeCore
      .warnings.length
  ) {
    for (
      const page of pages
    ) {
      if (
        page.datedRows > 0 ||
        page.paymentRows > 0
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
   * Clean native PDF: no OCR needed.
   */
  if (
    uniqueOcrPages.length ===
    0
  ) {
    return combinedFromCore(
      mergedNativeCore,
      pages.reduce(
        (
          total,
          page,
        ) =>
          total +
          page.rows.length,
        0,
      ),
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
   * OCR was required but every requested page failed.
   *
   * Do NOT silently pretend partial native extraction is complete.
   */
  if (
    ocrResult.texts.length ===
      0 &&
    ocrResult.failedPages.length >
      0
  ) {
    throw new Error(
      `The PDF opened, but ${ocrResult.failedPages.length} page(s) required deeper reading and OCR failed. Please try the statement again or check OCR configuration.`,
    );
  }

  const ocrCores =
    ocrResult.texts.map(
      (
        text,
      ) =>
        parseStatementText(
          text,
        ),
    );

  const finalCore =
    mergeCoreResults([
      ...nativeCores,
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
      )}.`,
    );
  }

  return combinedFromCore(
    finalCore,
    pages.reduce(
      (
        total,
        page,
      ) =>
        total +
        page.rows.length,
      0,
    ),
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

        raw:
          false,

        cellDates:
          false,
      },
    );

  const output:
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
      XLSX.utils.sheet_to_json<
        unknown[]
      >(
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
            ).map(
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
      output.push({
        name:
          sheetName,

        rows,
      });
    }
  }

  return output;
}

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

  const coreResults:
    CoreResult[] = [];

  let inheritedColumns:
    ColumnMap | null =
    null;

  let inputLines = 0;

  for (
    let index = 0;
    index <
    sheets.length;
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

    inputLines +=
      sheet.rows.length;

    /*
     * IMPORTANT:
     *
     * Sheet 2/3 can continue Sheet 1 without repeating headers.
     *
     * The CoreResult generated WITH inheritedColumns is the actual
     * result used later. We never throw this work away by re-parsing
     * through an independent wrapper.
     */
    const core =
      parseStatementRows(
        sheet.rows,
        inheritedColumns,
      );

    coreResults.push(
      core,
    );

    if (
      core.columns !==
      null
    ) {
      inheritedColumns =
        core.columns;
    }
  }

  const mergedCore =
    mergeCoreResults(
      coreResults,
    );

  return combinedFromCore(
    mergedCore,
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
    file.name.toLowerCase();

  const type =
    file.type.toLowerCase();

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
        "No readable bank statement text was found in this image.",
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
   * TXT / TEXT / OTHER BANK TEXT EXPORT
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
