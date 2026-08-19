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

function dedupeCredits(
  rows: UpiCredit[],
): UpiCredit[] {
  const seen = new Set<string>();
  const output: UpiCredit[] = [];

  for (const row of rows) {
    if (row.utr === "N/A") {
      output.push(row);
      continue;
    }

    const key = [
      row.utr,
      row.amount,
      row.mode,
    ]
      .join("|")
      .toUpperCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
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
    if (row.utr === "N/A") {
      output.push(row);
      continue;
    }

    const key = [
      row.utr,
      row.mode,
      row.amount,
    ]
      .join("|")
      .toUpperCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
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
          Boolean(
            transaction.reference,
          ),
      ).length,
    creditRows:
      core.transactions.filter(
        (transaction) =>
          transaction.direction ===
          "credit",
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
        result.credit.debug
          .columns !== null,
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
              result.credit.debug
                .inputLines,
            0,
          ),
        transactionRows:
          list.reduce(
            (total, result) =>
              total +
              result.credit.debug
                .transactionRows,
            0,
          ),
        upiRows:
          list.reduce(
            (total, result) =>
              total +
              result.credit.debug
                .upiRows,
            0,
          ),
        rowsWithReference:
          list.reduce(
            (total, result) =>
              total +
              result.credit.debug
                .rowsWithReference,
            0,
          ),
        creditRows:
          list.reduce(
            (total, result) =>
              total +
              result.credit.debug
                .creditRows,
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
  const normalized =
    normalizeText(text);

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
      columns.narration ===
      undefined
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

    if (isStrongCredit) {
      if (
        debitParts.length >= 2 &&
        creditParts.length === 0
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
      row[
        columns.debit
      ] =
        debitParts[0] ?? "";

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
      // optional worker URL
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
      // keep standard build alive
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
  visualText: string;
  sequentialText: string;
  characterCount: number;
  datedRows: number;
  paymentRows: number;
  numericRows: number;
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
    const maybeLength =
      Number(
        (
          value as {
            length?: unknown;
          }
        ).length,
      );

    if (
      Number.isInteger(
        maybeLength,
      ) &&
      maybeLength >= 0
    ) {
      const out:
        PdfTextItem[] = [];

      for (
        let index = 0;
        index < maybeLength;
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
          out.push(
            item as PdfTextItem,
          );
        }
      }

      if (out.length) {
        return out;
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

function numericTransformValue(
  transform: unknown,
  index: number,
): number {
  if (
    transform === null ||
    transform === undefined ||
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

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : 0;
}

function groupPdfItems(
  itemsValue: unknown,
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

  for (
    let index = 0;
    index < items.length;
    index++
  ) {
    const item =
      items[index];

    if (!item?.str) {
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
      numericTransformValue(
        item.transform,
        4,
      );

    const y =
      numericTransformValue(
        item.transform,
        5,
      );

    const key =
      Math.round(
        y / 2.5,
      ) * 2.5;

    const bucket =
      buckets.get(key) ??
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
      (a, b) =>
        b[0] - a[0],
    )
    .map(
      ([, row]) =>
        row
          .sort(
            (a, b) =>
              a.x - b.x,
          )
          .map(
            (item) =>
              normalizeText(
                item.text,
              ),
          )
          .filter(Boolean),
    )
    .filter(
      (row) =>
        row.length > 0,
    );
}

function rowsToText(
  rows: Row[],
): string {
  return rows
    .map(
      (row) =>
        row.join(" "),
    )
    .join("\n");
}

function sequentialPdfText(
  itemsValue: unknown,
): string {
  const items =
    coercePdfItems(
      itemsValue,
    );

  let output = "";

  for (
    let index = 0;
    index < items.length;
    index++
  ) {
    const item =
      items[index];

    const text =
      normalizeText(
        item?.str ?? "",
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

    if (item?.hasEOL) {
      output += "\n";
    } else {
      output += " ";
    }
  }

  return output
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const DATE_SIGNAL =
  /\b(?:\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/\s][A-Za-z]{3,9}[-/\s]\d{2,4})\b/;

const PAYMENT_SIGNAL =
  /\b(?:UPI|IMPS|NEFT|RTGS|IBNEFT|IBRTGS|ENEFT|ERTGS|BHIM|P2A|P2P|TRTR)\b/i;

const MONEY_SIGNAL =
  /(?:₹\s*)?(?:\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{1,2})/;

function evaluatePdfPage(
  pageNumber: number,
  rows: Row[],
  sequentialText: string,
): PdfPageExtraction {
  const visualText =
    rowsToText(rows);

  const bestText =
    visualText.length >=
    sequentialText.length
      ? visualText
      : sequentialText;

  const characterCount =
    bestText
      .replace(/\s/g, "")
      .length;

  let datedRows = 0;
  let paymentRows = 0;
  let numericRows = 0;

  const lines =
    bestText
      .split(/\n+/)
      .map(
        (line) =>
          line.trim(),
      )
      .filter(Boolean);

  for (const line of lines) {
    if (DATE_SIGNAL.test(line)) {
      datedRows++;
    }

    if (
      PAYMENT_SIGNAL.test(line)
    ) {
      paymentRows++;
    }

    if (MONEY_SIGNAL.test(line)) {
      numericRows++;
    }
  }

  const unreadable =
    characterCount < 40;

  return {
    pageNumber,
    rows,
    visualText,
    sequentialText,
    characterCount,
    datedRows,
    paymentRows,
    numericRows,
    unreadable,
  };
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

      const rows =
        groupPdfItems(
          content?.items,
        );

      const sequential =
        sequentialPdfText(
          content?.items,
        );

      pages.push(
        evaluatePdfPage(
          pageNumber,
          rows,
          sequential,
        ),
      );
    } catch {
      pages.push(
        evaluatePdfPage(
          pageNumber,
          [],
          "",
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
        base.width * 1.7,
        1200,
      ),
      1800,
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
    0.88,
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

/* ========================================================================== *
 * OCR
 * ========================================================================== */

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
    Array.from(
      new Set(pages),
    )
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

  const BATCH_SIZE = 2;

  for (
    let start = 0;
    start < unique.length;
    start += BATCH_SIZE
  ) {
    const batch =
      unique.slice(
        start,
        start + BATCH_SIZE,
      );

    onProgress?.(
      `Deep reading PDF pages ${start + 1}-${Math.min(
        start + batch.length,
        unique.length,
      )} of ${unique.length}…`,
    );

    const images: string[] = [];
    const renderedPages:
      number[] = [];

    for (const pageNumber of batch) {
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

    if (images.length === 0) {
      continue;
    }

    try {
      const text =
        await ocrImages(
          images,
        );

      if (text.trim()) {
        texts.push(text);
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
        (a, b) =>
          a - b,
      ),
  };
}

/* ========================================================================== *
 * CORE QUALITY
 * ========================================================================== */

function knownTransactionCount(
  core: CoreResult,
): number {
  return core.transactions
    .filter(
      (transaction) =>
        transaction.direction !==
          "unknown" &&
        transaction.amount !== null,
    )
    .length;
}

function coreScore(
  core: CoreResult,
): number {
  const known =
    knownTransactionCount(core);

  const withReference =
    core.transactions.filter(
      (transaction) =>
        Boolean(
          transaction.reference,
        ),
    ).length;

  const withMode =
    core.transactions.filter(
      (transaction) =>
        transaction.mode !== "OTHER",
    ).length;

  return (
    known * 10 +
    withReference * 2 +
    withMode +
    core.transactions.length
  );
}

function betterCore(
  first: CoreResult,
  second: CoreResult,
): CoreResult {
  return coreScore(second) >
    coreScore(first)
    ? second
    : first;
}

function bestCore(
  cores: CoreResult[],
): CoreResult {
  if (cores.length === 0) {
    return {
      transactions: [],
      columns: null,
      summary: null,
      warnings: [],
    };
  }

  return cores.reduce(
    (best, current) =>
      betterCore(
        best,
        current,
      ),
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

    const loadingTask =
      pdfjs.getDocument({
        data: bytes,
      });

    doc =
      await loadingTask.promise;
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
    `Reading ${Number(
      doc?.numPages ?? 0,
    )} PDF page(s)…`,
  );

  const pages =
    await extractPdfPages(doc);

  const allRows =
    pages.flatMap(
      (page) =>
        page.rows,
    );

  const detectedColumns =
    findColumns(allRows).columns;

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

  const visualText =
    pages
      .map(
        (page) =>
          page.visualText,
      )
      .filter(Boolean)
      .join("\n");

  const sequentialText =
    pages
      .map(
        (page) =>
          page.sequentialText,
      )
      .filter(Boolean)
      .join("\n");

  const nativeCandidates:
    CoreResult[] = [
      structuredCore,
    ];

  if (visualText.trim()) {
    nativeCandidates.push(
      parseStatementText(
        visualText,
      ),
    );
  }

  if (sequentialText.trim()) {
    nativeCandidates.push(
      parseStatementText(
        sequentialText,
      ),
    );
  }

  const nativeCore =
    bestCore(
      nativeCandidates,
    );

  const ocrPages =
    pages
      .filter(
        (page) =>
          page.unreadable,
      )
      .map(
        (page) =>
          page.pageNumber,
      );

  const nativeCharacters =
    pages.reduce(
      (total, page) =>
        total +
        page.characterCount,
      0,
    );

  if (
    ocrPages.length === 0
  ) {
    const warnings =
      knownTransactionCount(
        nativeCore,
      ) === 0 &&
      nativeCharacters >= 200
        ? [
            "Native PDF text was readable, but transaction columns could not be fully classified. OCR was not required because the PDF already contains a text layer.",
          ]
        : [];

    return combinedFromCore(
      nativeCore,
      repairedRows.length,
      warnings,
    );
  }

  onProgress?.(
    `${ocrPages.length} unreadable PDF page(s) need deeper reading…`,
  );

  const ocrResult =
    await ocrPdfPages(
      doc,
      ocrPages,
      onProgress,
    );

  if (
    ocrResult.texts.length === 0
  ) {
    if (
      nativeCharacters > 0 ||
      knownTransactionCount(
        nativeCore,
      ) > 0
    ) {
      return combinedFromCore(
        nativeCore,
        repairedRows.length,
        [
          `OCR could not verify PDF page(s): ${ocrResult.failedPages.join(
            ", ",
          )}. Native PDF text was used instead.`,
        ],
      );
    }

    throw new Error(
      `The PDF opened, but ${ocrPages.length} page(s) had no usable native text and OCR failed.`,
    );
  }

  const finalCandidates:
    CoreResult[] = [
      nativeCore,
      ...ocrResult.texts
        .filter(
          (text) =>
            Boolean(
              text.trim(),
            ),
        )
        .map(
          (text) =>
            parseStatementText(
              text,
            ),
        ),
    ];

  const finalCore =
    bestCore(
      finalCandidates,
    );

  const warnings: string[] = [];

  if (
    ocrResult.failedPages.length > 0
  ) {
    warnings.push(
      `OCR could not verify PDF page(s): ${ocrResult.failedPages.join(
        ", ",
      )}. Native PDF text was used for those pages where available.`,
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

  return normalizeText(value);
}

async function readWorkbookSheets(
  file: File,
): Promise<WorkbookSheet[]> {
  const XLSX =
    await import("xlsx");

  const workbook =
    XLSX.read(
      await file.arrayBuffer(),
      {
        type: "array",
        raw: false,
        cellDates: false,
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
          (rawRow) =>
            rawRow.map(
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

function columnSignature(
  columns: ColumnMap | null,
): string {
  if (columns === null) {
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
      (value) =>
        value === undefined
          ? "-"
          : String(value),
    )
    .join("|");
}

type SheetGroup = {
  rows: Row[];
  columns: ColumnMap | null;
};

function groupWorkbookSheets(
  sheets: WorkbookSheet[],
): SheetGroup[] {
  const groups: SheetGroup[] = [];

  let currentRows: Row[] = [];
  let currentColumns:
    ColumnMap | null = null;
  let currentSignature = "";

  const flush = () => {
    if (currentRows.length === 0) {
      return;
    }

    groups.push({
      rows: currentRows,
      columns: currentColumns,
    });

    currentRows = [];
    currentColumns = null;
    currentSignature = "";
  };

  for (const sheet of sheets) {
    const detected =
      findColumns(
        sheet.rows,
      ).columns;

    const signature =
      columnSignature(
        detected,
      );

    if (currentRows.length === 0) {
      currentRows = [
        ...sheet.rows,
      ];

      currentColumns =
        detected;

      currentSignature =
        signature;

      continue;
    }

    if (detected === null) {
      currentRows.push(
        ...sheet.rows,
      );
      continue;
    }

    if (currentColumns === null) {
      currentRows.push(
        ...sheet.rows,
      );

      currentColumns =
        detected;

      currentSignature =
        signature;

      continue;
    }

    if (
      signature ===
      currentSignature
    ) {
      currentRows.push(
        ...sheet.rows,
      );
      continue;
    }

    flush();

    currentRows = [
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

function parseWorkbook(
  sheets: WorkbookSheet[],
  onProgress?: ExtractProgress,
): CombinedResult {
  if (sheets.length === 0) {
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
    index < groups.length;
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
      "Reading scanned statement image…",
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

    return fromText(text);
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

  if (!text.trim()) {
    throw new Error(
      "This text statement is empty.",
    );
  }

  return fromText(text);
}
