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
 * STATEMENT READERS — V4
 *
 * Goals:
 * - Preserve existing parser behavior for working banks.
 * - Read XLS/XLSX/CSV sheet-by-sheet with inherited column maps.
 * - Repair malformed Withdrawals/Deposits/Balance exports before core parsing.
 * - Use native PDF text first and avoid OCR when a readable text layer exists.
 * - Merge complementary native PDF parses instead of selecting one winner.
 * - Keep OCR as a true last resort.
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

  const reason = diagnosticReason(
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
  const creditRows = dedupeCredits(
    core.transactions
      .map(toCredit)
      .filter(
        (row): row is UpiCredit =>
          row !== null,
      ),
  );

  const debitRows = dedupeDebits(
    core.transactions
      .map(toDebit)
      .filter(
        (row): row is DebitTxn =>
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
    accepted: creditRows.length,
    columns: core.columns,
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
        accepted: credits.length,
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
 * CORE CANDIDATE MERGE
 * ========================================================================== */

function transactionQuality(
  transaction: CoreTransaction,
): number {
  let score = 0;

  if (transaction.direction !== "unknown") {
    score += 10;
  }

  if (transaction.amount !== null) {
    score += 8;
  }

  if (transaction.reference) {
    score += 5;
  }

  if (transaction.mode !== "OTHER") {
    score += 3;
  }

  if (transaction.balance !== null) {
    score += 2;
  }

  if (transaction.confidence === "high") {
    score += 3;
  } else if (
    transaction.confidence === "medium"
  ) {
    score += 1;
  }

  return score;
}

function nativeTransactionKey(
  transaction: CoreTransaction,
): string {
  if (transaction.reference) {
    return [
      "REF",
      transaction.reference,
      transaction.direction,
      transaction.mode,
    ]
      .join("|")
      .toUpperCase();
  }

  return [
    "NOREF",
    transaction.date,
    transaction.direction,
    transaction.mode,
    transaction.amount?.toFixed(2) ?? "",
    normalizeText(
      transaction.narration,
    ).slice(0, 100),
  ]
    .join("|")
    .toUpperCase();
}

function mergeCoreCandidates(
  results: CoreResult[],
): CoreResult {
  const map =
    new Map<
      string,
      CoreTransaction
    >();

  let columns:
    ColumnMap | null =
    null;

  let summary:
    CoreResult["summary"] =
    null;

  const warnings =
    new Set<string>();

  for (const result of results) {
    if (
      columns === null &&
      result.columns !== null
    ) {
      columns = result.columns;
    }

    if (
      summary === null &&
      result.summary !== null
    ) {
      summary = result.summary;
    }

    result.warnings.forEach(
      (warning) =>
        warnings.add(warning),
    );

    for (
      const transaction of
      result.transactions
    ) {
      const key =
        nativeTransactionKey(
          transaction,
        );

      const old =
        map.get(key);

      if (
        !old ||
        transactionQuality(
          transaction,
        ) >
          transactionQuality(old)
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
      [...warnings],
  };
}

function knownTransactionCount(
  core: CoreResult,
): number {
  return core.transactions.filter(
    (transaction) =>
      transaction.direction !== "unknown" &&
      transaction.amount !== null,
  ).length;
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
 * MALFORMED BANK EXPORT REPAIR
 * ========================================================================== */

function moneyParts(
  value: unknown,
): string[] {
  const text =
    normalizeText(value);

  if (!text) {
    return [];
  }

  return (
    text.match(
      /[+-]?(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?/g,
    ) ?? []
  );
}

function strongCreditNarration(
  text: string,
): boolean {
  return (
    /(?:^|[/_: -])UPI[/_: -]+CR(?:[/_: -]|$)/i.test(
      normalizeText(text),
    ) ||
    /\b(?:credited|credit received|amount received|deposited)\b/i.test(
      normalizeText(text),
    )
  );
}

function repairShiftedAmountBalanceRows(
  inputRows: Row[],
  inheritedColumns:
    ColumnMap | null = null,
): Row[] {
  const rows: Row[] =
    inputRows.map(
      (row) =>
        row.map(
          (cell) =>
            normalizeText(cell),
        ),
    );

  const detected =
    findColumns(rows);

  const columns =
    detected.columns ??
    inheritedColumns;

  if (
    columns?.debit === undefined ||
    columns.credit === undefined ||
    columns.balance === undefined
  ) {
    return rows;
  }

  for (const row of rows) {
    const balanceCell =
      normalizeText(
        row[
          columns.balance
        ] ?? "",
      );

    if (balanceCell) {
      continue;
    }

    const debitCell =
      normalizeText(
        row[
          columns.debit
        ] ?? "",
      );

    const creditCell =
      normalizeText(
        row[
          columns.credit
        ] ?? "",
      );

    const debitParts =
      moneyParts(debitCell);

    const creditParts =
      moneyParts(creditCell);

    const narration =
      columns.narration === undefined
        ? row.join(" ")
        : normalizeText(
            row[
              columns.narration
            ] ?? "",
          );

    const isStrongCredit =
      strongCreditNarration(
        narration,
      );

    if (
      isStrongCredit &&
      debitParts.length === 1 &&
      creditParts.length === 1
    ) {
      row[
        columns.debit
      ] = "";

      row[
        columns.credit
      ] =
        debitParts[0] ?? "";

      row[
        columns.balance
      ] =
        creditParts[0] ?? "";

      continue;
    }

    if (
      debitParts.length === 0 &&
      creditParts.length >= 2
    ) {
      row[
        columns.credit
      ] =
        creditParts[0] ?? "";

      row[
        columns.balance
      ] =
        creditParts[
          creditParts.length - 1
        ] ?? "";

      continue;
    }

    if (
      creditParts.length === 0 &&
      debitParts.length >= 2
    ) {
      if (isStrongCredit) {
        row[
          columns.debit
        ] = "";

        row[
          columns.credit
        ] =
          debitParts[0] ?? "";
      } else {
        row[
          columns.debit
        ] =
          debitParts[0] ?? "";
      }

      row[
        columns.balance
      ] =
        debitParts[
          debitParts.length - 1
        ] ?? "";

      continue;
    }

    if (
      debitParts.length === 1 &&
      creditParts.length === 1
    ) {
      row[
        columns.balance
      ] =
        creditParts[0] ?? "";

      row[
        columns.credit
      ] = "";
    }
  }

  return rows;
}

/* ========================================================================== *
 * PDF.JS
 * ========================================================================== */

async function loadPdfjs(): Promise<any> {
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
      // Worker URL is optional.
    }

    return pdfjs;
  } catch {
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
      // Standard build can still report a useful loading error.
    }

    return pdfjs;
  }
}

type PdfTextItem = {
  str?: string;
  transform?: unknown;
  hasEOL?: boolean;
};

type PdfPageExtraction = {
  pageNumber: number;
  rows: Row[];
  sequentialText: string;
  characterCount: number;
  unreadable: boolean;
};

function coercePdfItems(
  value: unknown,
): PdfTextItem[] {
  if (Array.isArray(value)) {
    return value as PdfTextItem[];
  }

  if (
    value &&
    typeof value === "object"
  ) {
    const length =
      Number(
        (
          value as {
            length?: unknown;
          }
        ).length,
      );

    if (
      Number.isInteger(length) &&
      length >= 0
    ) {
      const output:
        PdfTextItem[] = [];

      for (
        let index = 0;
        index < length;
        index++
      ) {
        const item =
          (
            value as Record<
              number,
              unknown
            >
          )[index];

        if (
          item &&
          typeof item === "object"
        ) {
          output.push(
            item as PdfTextItem,
          );
        }
      }

      if (output.length > 0) {
        return output;
      }
    }

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
      typeof iterator === "function"
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

function transformNumber(
  transform: unknown,
  index: number,
): number {
  if (
    !transform ||
    typeof transform !== "object"
  ) {
    return 0;
  }

  const value =
    (
      transform as Record<
        number,
        unknown
      >
    )[index];

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : 0;
}

function groupPdfItems(
  itemsValue: unknown,
): Row[] {
  const items =
    coercePdfItems(
      itemsValue,
    );

  const lines =
    new Map<
      number,
      Array<{
        x: number;
        text: string;
      }>
    >();

  for (const item of items) {
    const text =
      normalizeText(
        item.str ?? "",
      );

    if (!text) {
      continue;
    }

    const x =
      transformNumber(
        item.transform,
        4,
      );

    const y =
      transformNumber(
        item.transform,
        5,
      );

    const key =
      Math.round(
        y / 2.5,
      ) * 2.5;

    const line =
      lines.get(key) ??
      [];

    line.push({
      x,
      text,
    });

    lines.set(
      key,
      line,
    );
  }

  return [
    ...lines.entries(),
  ]
    .sort(
      (a, b) =>
        b[0] - a[0],
    )
    .map(
      ([, line]) =>
        line
          .sort(
            (a, b) =>
              a.x - b.x,
          )
          .map(
            (item) =>
              item.text,
          )
          .filter(Boolean),
    )
    .filter(
      (row) =>
        row.length > 0,
    );
}

function sequentialPdfText(
  itemsValue: unknown,
): string {
  const items =
    coercePdfItems(
      itemsValue,
    );

  let output = "";

  for (const item of items) {
    const text =
      normalizeText(
        item.str ?? "",
      );

    if (!text) {
      continue;
    }

    if (
      output &&
      !output.endsWith("\n") &&
      !output.endsWith(" ")
    ) {
      output += " ";
    }

    output += text;

    output += item.hasEOL
      ? "\n"
      : " ";
  }

  return output
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractPdfPages(
  doc: any,
): Promise<PdfPageExtraction[]> {
  const pages:
    PdfPageExtraction[] = [];

  const pageCount =
    Number(
      doc?.numPages ?? 0,
    );

  for (
    let pageNumber = 1;
    pageNumber <= pageCount;
    pageNumber++
  ) {
    try {
      const page =
        await doc.getPage(
          pageNumber,
        );

      const content =
        await page.getTextContent();

      const sequentialText =
        sequentialPdfText(
          content?.items,
        );

      const rows =
        groupPdfItems(
          content?.items,
        );

      const characterCount =
        sequentialText
          .replace(/\s/g, "")
          .length;

      pages.push({
        pageNumber,
        rows,
        sequentialText,
        characterCount,
        unreadable:
          characterCount < 40,
      });
    } catch {
      pages.push({
        pageNumber,
        rows: [],
        sequentialText: "",
        characterCount: 0,
        unreadable: true,
      });
    }
  }

  return pages;
}

/* ========================================================================== *
 * OCR
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
        base.width * 1.45,
        1000,
      ),
      1500,
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

  if (!context) {
    throw new Error(
      "Could not render this PDF page.",
    );
  }

  await page.render({
    canvasContext: context,
    viewport,
    canvas,
  }).promise;

  return canvas.toDataURL(
    "image/jpeg",
    0.84,
  );
}

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

type OcrBatchResult = {
  texts: string[];
  failedPages: number[];
};

async function ocrPdfPages(
  doc: any,
  pages: number[],
  onProgress?: ExtractProgress,
): Promise<OcrBatchResult> {
  const unique =
    [
      ...new Set(pages),
    ]
      .filter(
        (page) =>
          page >= 1 &&
          page <=
            Number(
              doc?.numPages ?? 0,
            ),
      )
      .sort(
        (a, b) =>
          a - b,
      );

  const texts: string[] = [];
  const failedPages:
    number[] = [];

  for (
    let index = 0;
    index < unique.length;
    index++
  ) {
    const pageNumber =
      unique[index];

    if (
      pageNumber === undefined
    ) {
      continue;
    }

    onProgress?.(
      `OCR fallback page ${index + 1} of ${unique.length}…`,
    );

    try {
      const image =
        await pageToDataUrl(
          doc,
          pageNumber,
        );

      const text =
        await ocrImages([
          image,
        ]);

      if (text.trim()) {
        texts.push(text);
      } else {
        failedPages.push(
          pageNumber,
        );
      }
    } catch {
      failedPages.push(
        pageNumber,
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
        (a, b) =>
          a - b,
      ),
  };
}

/* ========================================================================== *
 * PDF READER
 * ========================================================================== */

async function readPdf(
  file: File,
  onProgress?: ExtractProgress,
): Promise<CombinedResult> {
  onProgress?.(
    "Reader V4: opening PDF…",
  );

  let pdfjs: any;

  try {
    pdfjs =
      await loadPdfjs();
  } catch {
    throw new Error(
      "PDF reader could not be loaded on this browser.",
    );
  }

  let doc: any;

  try {
    const bytes =
      new Uint8Array(
        await file.arrayBuffer(),
      );

    doc =
      await pdfjs.getDocument({
        data: bytes,
      }).promise;
  } catch (error) {
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
    `Reader V4: reading ${Number(
      doc?.numPages ?? 0,
    )} PDF page(s)…`,
  );

  const pages =
    await extractPdfPages(
      doc,
    );

  const allRows =
    pages.flatMap(
      (page) =>
        page.rows,
    );

  const detectedColumns =
    findColumns(
      allRows,
    ).columns;

  const repairedRows =
    repairShiftedAmountBalanceRows(
      allRows,
      detectedColumns,
    );

  const nativeCores:
    CoreResult[] = [];

  if (repairedRows.length > 0) {
    nativeCores.push(
      parseStatementRows(
        repairedRows,
        detectedColumns,
      ),
    );
  }

  const sequentialText =
    pages
      .map(
        (page) =>
          page.sequentialText,
      )
      .filter(Boolean)
      .join("\n");

  if (sequentialText.trim()) {
    nativeCores.push(
      parseStatementText(
        sequentialText,
      ),
    );
  }

  const nativeCore =
    mergeCoreCandidates(
      nativeCores,
    );

  const nativeCharacters =
    pages.reduce(
      (total, page) =>
        total +
        page.characterCount,
      0,
    );

  const unreadablePages =
    pages
      .filter(
        (page) =>
          page.unreadable,
      )
      .map(
        (page) =>
          page.pageNumber,
      );

  if (
    knownTransactionCount(
      nativeCore,
    ) > 0
  ) {
    const warnings =
      unreadablePages.length > 0
        ? [
            `Native PDF text was used. Page(s) ${unreadablePages.join(
              ", ",
            )} had weak text extraction, but OCR was skipped because valid transactions were already recovered.`,
          ]
        : [];

    return combinedFromCore(
      nativeCore,
      repairedRows.length,
      warnings,
    );
  }

  if (
    nativeCharacters >= 200
  ) {
    return combinedFromCore(
      nativeCore,
      repairedRows.length,
      [
        "The PDF contains readable native text, but no transaction could be classified. OCR was intentionally skipped to avoid slow unnecessary processing.",
      ],
    );
  }

  if (
    unreadablePages.length === 0
  ) {
    return combinedFromCore(
      nativeCore,
      repairedRows.length,
    );
  }

  onProgress?.(
    `${unreadablePages.length} scanned/unreadable PDF page(s) require OCR…`,
  );

  const ocrResult =
    await ocrPdfPages(
      doc,
      unreadablePages,
      onProgress,
    );

  if (
    ocrResult.texts.length === 0
  ) {
    throw new Error(
      `The PDF has no usable native text and OCR failed for page(s): ${unreadablePages.join(
        ", ",
      )}.`,
    );
  }

  const ocrCores =
    ocrResult.texts.map(
      (text) =>
        parseStatementText(
          text,
        ),
    );

  const finalCore =
    mergeCoreCandidates([
      nativeCore,
      ...ocrCores,
    ]);

  const warnings:
    string[] = [];

  if (
    ocrResult.failedPages.length > 0
  ) {
    warnings.push(
      `OCR could not read PDF page(s): ${ocrResult.failedPages.join(
        ", ",
      )}.`,
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

    const rows:
      Row[] =
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

    if (rows.length > 0) {
      sheets.push({
        name: sheetName,
        rows,
      });
    }
  }

  return sheets;
}

function parseWorkbook(
  sheets: WorkbookSheet[],
  onProgress?: ExtractProgress,
): CombinedResult {
  if (sheets.length === 0) {
    return emptyCombined();
  }

  const results:
    CombinedResult[] = [];

  let inheritedColumns:
    ColumnMap | null =
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
      `Reader V4: reading sheet ${index + 1} of ${sheets.length}…`,
    );

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

    const repairedRows =
      repairShiftedAmountBalanceRows(
        sheet.rows,
        activeColumns,
      );

    const core =
      parseStatementRows(
        repairedRows,
        activeColumns,
      );

    results.push(
      combinedFromCore(
        core,
        repairedRows.length,
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
      "Reader V4: reading statement image…",
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

    if (!text.trim()) {
      throw new Error(
        "No readable bank statement transactions were found in this image.",
      );
    }

    return fromText(
      text,
    );
  }

  if (
    name.endsWith(".pdf") ||
    type === "application/pdf"
  ) {
    return await readPdf(
      file,
      onProgress,
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
      "Reader V4: opening spreadsheet…",
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

    if (sheets.length === 0) {
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
    "Reader V4: reading text statement…",
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

  if (!text.trim()) {
    throw new Error(
      "This text statement is empty.",
    );
  }

  return fromText(
    text,
  );
}
