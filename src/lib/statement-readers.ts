import {
  ocrStatementPages,
} from "./ocr.functions";

import {
  mergeResults,
  parseRowsDetailed,
  parseTextDetailed,
  type ExtractResult,
  type Row,
} from "./upi-parser";

import {
  mergeDebitResults,
  parseDebitsFromRows,
  parseDebitsFromText,
  type DebitResult,
} from "./debit-parser";

import {
  mergeCoreResults,
  normalizeText,
  parseStatementRows,
  type ColumnMap,
  type CoreResult,
} from "./statement-core";

/* ========================================================================== *
 * PUBLIC RESULT
 * ========================================================================== */

export type CombinedResult = {
  credit: ExtractResult;
  debit: DebitResult;
};

export type ExtractProgress = (
  stage: string,
) => void;

/* ========================================================================== *
 * BASIC ADAPTERS
 * ========================================================================== */

function emptyCombined(): CombinedResult {
  return {
    credit:
      parseTextDetailed(
        "",
      ),

    debit:
      parseDebitsFromText(
        "",
      ),
  };
}

function fromText(
  text: string,
): CombinedResult {
  return {
    credit:
      parseTextDetailed(
        text,
      ),

    debit:
      parseDebitsFromText(
        text,
      ),
  };
}

function fromRows(
  rows: Row[],
): CombinedResult {
  return {
    credit:
      parseRowsDetailed(
        rows,
      ),

    debit:
      parseDebitsFromRows(
        rows,
      ),
  };
}

export function mergeCombined(
  list: CombinedResult[],
): CombinedResult {
  if (
    list.length === 0
  ) {
    return emptyCombined();
  }

  return {
    credit:
      mergeResults(
        list.map(
          (
            item,
          ) =>
            item.credit,
        ),
      ),

    debit:
      mergeDebitResults(
        list.map(
          (
            item,
          ) =>
            item.debit,
        ),
      ),
  };
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
 * PDF TEXT TYPES
 * ========================================================================== */

type PdfTextItem = {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
};

type PdfPageExtraction = {
  pageNumber: number;

  /*
   * Human-readable line text.
   */
  text: string;

  /*
   * Each visual line represented as cells.
   */
  rows: Row[];

  /*
   * Text quality stats.
   */
  characterCount: number;
  datedRows: number;
  paymentRows: number;
  numericRows: number;
  suspicious: boolean;
};

/* ========================================================================== *
 * PDF VISUAL ROW EXTRACTION
 * ========================================================================== */

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
     * PDF text positions can differ slightly for items
     * which visually belong to same row.
     *
     * Bucket every ~2.5 points.
     */
    const key =
      Math.round(
        y / 2.5,
      ) * 2.5;

    const list =
      buckets.get(
        key,
      ) ?? [];

    list.push({
      x,
      text,
    });

    buckets.set(
      key,
      list,
    );
  }

  const rows:
    Row[] = [];

  const ordered =
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
      cells,
    ] of ordered
  ) {
    const sorted =
      cells.sort(
        (
          a,
          b,
        ) =>
          a.x -
          b.x,
      );

    /*
     * Preserve individual PDF text items.
     *
     * This is better than flattening everything to one string because
     * structured PDF statements frequently keep columns as separate items.
     */
    const row =
      sorted
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

function pdfRowsToText(
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
  /\b(?:UPI|IMPS|NEFT|RTGS|IBNEFT|IBRTGS|BHIM|P2A|TRTR)\b/i;

const MONEY_SIGNAL =
  /(?:₹\s*)?(?:\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{1,2})/;

function evaluatePdfPage(
  pageNumber: number,
  rows: Row[],
): PdfPageExtraction {
  const text =
    pdfRowsToText(
      rows,
    );

  const compactLength =
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

  /*
   * Suspicious page conditions:
   *
   * 1. Very little native text
   * 2. Has date/payment hints but almost no usable numeric rows
   * 3. Looks like transaction page but parser surface is very thin
   *
   * We intentionally prefer false-positive OCR over silently missing rows.
   */
  const suspicious =
    compactLength < 180 ||
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
    characterCount:
      compactLength,
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

  /*
   * First calculate desired image size.
   */
  const base =
    page.getViewport({
      scale: 1,
    });

  /*
   * 2000-2400px width is usually enough for bank table OCR.
   */
  const targetWidth =
    Math.min(
      Math.max(
        base.width * 2.2,
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
 * FILE -> IMAGE DATA URL
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
    images.length === 0
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

/**
 * Run OCR in smaller batches.
 *
 * This avoids huge payloads/browser memory spikes and,
 * unlike the old implementation, does NOT silently ignore
 * every page after page 12.
 */
async function ocrPdfPages(
  doc: any,
  pages: number[],
  onProgress?: ExtractProgress,
): Promise<string[]> {
  const unique =
    [...new Set(
      pages,
    )]
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

  if (
    unique.length === 0
  ) {
    return [];
  }

  const OCR_BATCH =
    4;

  const texts:
    string[] = [];

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
      `OCR pages ${start + 1}-${Math.min(
        start +
          batch.length,
        unique.length,
      )} of ${unique.length}…`,
    );

    const images:
      string[] = [];

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
      } catch {
        /*
         * A single render error must not abort entire statement.
         */
      }
    }

    if (
      images.length === 0
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
      }
    } catch {
      /*
       * One OCR batch failure should not destroy already parsed pages.
       */
    }
  }

  return texts;
}

/* ========================================================================== *
 * NATIVE PDF PAGE PARSING
 * ========================================================================== */

type NativePageParse = {
  page: PdfPageExtraction;
  result: CombinedResult;
  core: CoreResult;
};

function parseNativePage(
  page: PdfPageExtraction,
  inheritedColumns:
    ColumnMap | null,
): NativePageParse {
  /*
   * Parse structured visual rows directly through core.
   *
   * This is much stronger than flattening PDF into plain text first.
   */
  const core =
    parseStatementRows(
      page.rows,
      inheritedColumns,
    );

  /*
   * Keep UI-facing credit/debit parsers in sync.
   *
   * If structured rows produce no useful result, text parsing is also
   * merged because some PDFs expose the whole transaction as one visual item.
   */
  const rowResult =
    fromRows(
      page.rows,
    );

  const textResult =
    fromText(
      page.text,
    );

  const result =
    mergeCombined([
      rowResult,
      textResult,
    ]);

  return {
    page,
    result,
    core,
  };
}

/**
 * Decide whether a page deserves OCR even when native parser
 * found SOME rows.
 *
 * This solves the old problem:
 * native parser finds 2 transactions from a 100-row statement,
 * therefore OCR never runs.
 */
function shouldOcrParsedPage(
  parsed:
    NativePageParse,
): boolean {
  const page =
    parsed.page;

  if (
    page.suspicious
  ) {
    return true;
  }

  const creditCount =
    parsed.result.credit
      .rows.length;

  const debitCount =
    parsed.result.debit
      .rows.length;

  const transactionCount =
    creditCount +
    debitCount;

  /*
   * Native page visibly has many transaction-like rows,
   * but parser found very few transactions.
   */
  if (
    page.datedRows >= 4 &&
    transactionCount <
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

  /*
   * Payment keywords are visible but virtually none
   * became transactions.
   */
  if (
    page.paymentRows >= 3 &&
    transactionCount === 0
  ) {
    return true;
  }

  /*
   * Native text exists but no direction was recoverable.
   */
  if (
    page.datedRows >= 2 &&
    transactionCount === 0
  ) {
    return true;
  }

  return false;
}

/* ========================================================================== *
 * SPREADSHEET
 * ========================================================================== */

type SheetRows = {
  name: string;
  rows: Row[];
};

async function readWorkbookSheets(
  file: File,
): Promise<SheetRows[]> {
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
         * Preserve displayed values.
         *
         * Core also supports Excel serial dates if they survive,
         * but displayed values are usually safer for bank statements.
         */
        raw:
          false,

        cellDates:
          false,
      },
    );

  const output:
    SheetRows[] = [];

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
            row,
          ) =>
            (
              row as unknown[]
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
      rows.length
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

/**
 * Parse every worksheet independently.
 *
 * Header inheritance:
 * - if Sheet 1 has columns
 * - Sheet 2 is continuation without repeated header
 * then previous columns are passed to Sheet 2.
 */
function parseWorkbookSheets(
  sheets: SheetRows[],
  onProgress?: ExtractProgress,
): CombinedResult {
  if (
    sheets.length === 0
  ) {
    return emptyCombined();
  }

  const combined:
    CombinedResult[] = [];

  const coreResults:
    CoreResult[] = [];

  let inheritedColumns:
    ColumnMap | null =
    null;

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

    const core =
      parseStatementRows(
        sheet.rows,
        inheritedColumns,
      );

    if (
      core.columns
    ) {
      inheritedColumns =
        core.columns;
    }

    coreResults.push(
      core,
    );

    /*
     * Public parser layer.
     *
     * Header inheritance currently lives in core, while the legacy
     * UPI/debit wrappers parse their own rows. For continuation sheets
     * where wrappers cannot discover columns, core still preserves
     * transaction understanding for later architecture expansion.
     */
    combined.push(
      fromRows(
        sheet.rows,
      ),
    );
  }

  /*
   * Trigger core merge so its dedupe/validation path is executed.
   * Current CombinedResult remains API-compatible with existing UI.
   */
  mergeCoreResults(
    coreResults,
  );

  return mergeCombined(
    combined,
  );
}

/* ========================================================================== *
 * PDF READER
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
    CombinedResult[] = [];

  const nativeCore:
    CoreResult[] = [];

  const ocrPages:
    number[] = [];

  let inheritedColumns:
    ColumnMap | null =
    null;

  for (
    const page of pages
  ) {
    const parsed =
      parseNativePage(
        page,
        inheritedColumns,
      );

    nativeResults.push(
      parsed.result,
    );

    nativeCore.push(
      parsed.core,
    );

    if (
      parsed.core.columns
    ) {
      inheritedColumns =
        parsed.core.columns;
    }

    if (
      shouldOcrParsedPage(
        parsed,
      )
    ) {
      ocrPages.push(
        page.pageNumber,
      );
    }
  }

  /*
   * If the complete native document produced absolutely nothing,
   * OCR every page.
   */
  const nativeMerged =
    mergeCombined(
      nativeResults,
    );

  const noNativeTransactions =
    nativeMerged.credit
      .rows.length === 0 &&
    nativeMerged.debit
      .rows.length === 0;

  if (
    noNativeTransactions
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
   * Also consider official summary mismatch.
   *
   * If core sees a bank-provided total/count and reports mismatch,
   * OCR transaction-looking pages as a recovery attempt.
   */
  const mergedNativeCore =
    mergeCoreResults(
      nativeCore,
    );

  if (
    mergedNativeCore
      .warnings
      .length
  ) {
    for (
      const page of pages
    ) {
      if (
        page.datedRows >= 1 ||
        page.paymentRows >= 1
      ) {
        ocrPages.push(
          page.pageNumber,
        );
      }
    }
  }

  const uniqueOcrPages =
    [...new Set(
      ocrPages,
    )];

  if (
    uniqueOcrPages.length === 0
  ) {
    return nativeMerged;
  }

  onProgress?.(
    `Native PDF check found ${uniqueOcrPages.length} page(s) needing deeper reading…`,
  );

  const ocrTexts =
    await ocrPdfPages(
      doc,
      uniqueOcrPages,
      onProgress,
    );

  if (
    ocrTexts.length === 0
  ) {
    return nativeMerged;
  }

  const ocrResults =
    ocrTexts.map(
      (
        text,
      ) =>
        fromText(
          text,
        ),
    );

  /*
   * Native and OCR are intentionally merged.
   *
   * We do not throw away native rows just because OCR ran,
   * and we do not trust OCR alone where native text is clean.
   */
  return mergeCombined([
    ...nativeResults,
    ...ocrResults,
  ]);
}

/* ========================================================================== *
 * MAIN READER
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

    const text =
      await ocrImages([
        image,
      ]);

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

    try {
      const sheets =
        await readWorkbookSheets(
          file,
        );

      return parseWorkbookSheets(
        sheets,
        onProgress,
      );
    } catch (
      error
    ) {
      const message =
        error instanceof Error
          ? error.message
          : "";

      throw new Error(
        message ||
        "Unable to read this spreadsheet file.",
      );
    }
  }

  /* ------------------------------------------------------------------------ *
   * TXT / PLAIN TEXT / BANK EXPORT
   * ------------------------------------------------------------------------ */

  onProgress?.(
    "Reading text statement…",
  );

  try {
    const text =
      await file.text();

    if (
      !text.trim()
    ) {
      return emptyCombined();
    }

    return fromText(
      text,
    );
  } catch {
    throw new Error(
      "Unable to read this text file.",
    );
  }
}
