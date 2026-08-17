import { ocrStatementPages } from "./ocr.functions";

import type {
  ExtractResult,
  Row,
} from "./upi-parser";

import {
  mergeResults,
  parseRowsDetailed,
  parseTextDetailed,
} from "./upi-parser";

import {
  mergeDebitResults,
  parseDebitsFromRows,
  parseDebitsFromText,
  type DebitResult,
} from "./debit-parser";

export type CombinedResult = {
  credit: ExtractResult;
  debit: DebitResult;
};

/* ------------------------------------------------------------------ *
 * Shared parser adapters
 * ------------------------------------------------------------------ */

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
  return {
    credit:
      mergeResults(
        list.map(
          (item) =>
            item.credit,
        ),
      ),

    debit:
      mergeDebitResults(
        list.map(
          (item) =>
            item.debit,
        ),
      ),
  };
}

/* ------------------------------------------------------------------ *
 * PDF.js
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * PDF text layer extraction
 * ------------------------------------------------------------------ */

/**
 * Extract text while preserving visual rows as much as possible.
 *
 * PDF text items contain X/Y coordinates.
 * We group items with similar Y coordinates into the same line,
 * then order cells by X position.
 */
async function pdfText(
  doc: any,
): Promise<{
  text: string;
  sparsePages: number[];
}> {
  const pages:
    string[] = [];

  const sparsePages:
    number[] = [];

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

    const lines =
      new Map<
        number,
        Array<{
          x: number;
          text: string;
        }>
      >();

    for (
      const item of
        content.items as Array<{
          str?: string;
          transform?: number[];
        }>
    ) {
      if (
        !item.str ||
        !item.transform
      ) {
        continue;
      }

      const x =
        item.transform[4] ??
        0;

      const y =
        Math.round(
          item.transform[5] ??
            0,
        );

      /*
       * Nearby Y positions belong to same visual row.
       */
      const rowKey =
        Math.round(
          y / 3,
        ) * 3;

      const existing =
        lines.get(
          rowKey,
        ) ?? [];

      existing.push({
        x,
        text:
          item.str,
      });

      lines.set(
        rowKey,
        existing,
      );
    }

    const orderedLines =
      [...lines.entries()]
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
              items,
            ],
          ) =>
            items
              .sort(
                (
                  a,
                  b,
                ) =>
                  a.x -
                  b.x,
              )
              .map(
                (item) =>
                  item.text,
              )
              .join(" "),
        );

    const pageText =
      orderedLines.join(
        "\n",
      );

    /*
     * If very little text exists, page may be scanned/image based.
     */
    if (
      pageText
        .replace(
          /\s/g,
          "",
        )
        .length < 200
    ) {
      sparsePages.push(
        pageNumber,
      );
    }

    pages.push(
      pageText,
    );
  }

  return {
    text:
      pages.join(
        "\n",
      ),

    sparsePages,
  };
}

/* ------------------------------------------------------------------ *
 * PDF page → image for OCR
 * ------------------------------------------------------------------ */

async function pageToDataUrl(
  doc: any,
  pageNumber: number,
): Promise<string> {
  const page =
    await doc.getPage(
      pageNumber,
    );

  const initialViewport =
    page.getViewport({
      scale: 2,
    });

  const canvas =
    document.createElement(
      "canvas",
    );

  /*
   * Prevent huge browser canvas.
   */
  canvas.width =
    Math.min(
      initialViewport.width,
      2200,
    );

  canvas.height =
    Math.round(
      (
        canvas.width /
        initialViewport.width
      ) *
        initialViewport.height,
    );

  const ctx =
    canvas.getContext(
      "2d",
    );

  if (
    !ctx
  ) {
    throw new Error(
      "Could not render this PDF page.",
    );
  }

  const scale =
    (
      canvas.width /
      initialViewport.width
    ) * 2;

  const viewport =
    page.getViewport({
      scale,
    });

  await page.render({
    canvasContext:
      ctx,

    viewport,

    canvas,
  }).promise;

  return canvas.toDataURL(
    "image/jpeg",
    0.92,
  );
}

/* ------------------------------------------------------------------ *
 * Image file → data URL
 * ------------------------------------------------------------------ */

async function fileToDataUrl(
  file: File,
): Promise<string> {
  return await new Promise(
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
              reader.result,
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

/* ------------------------------------------------------------------ *
 * OCR
 * ------------------------------------------------------------------ */

async function ocr(
  images: string[],
): Promise<string> {
  const {
    text,
  } =
    await ocrStatementPages({
      data: {
        images,
      },
    });

  return text;
}

/* ------------------------------------------------------------------ *
 * XLS / XLSX / CSV
 * ------------------------------------------------------------------ */

async function readSheetRows(
  file: File,
): Promise<Row[]> {
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
         * Preserve displayed text instead of raw Excel serials.
         */
        raw:
          false,
      },
    );

  const rows:
    Row[] = [];

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
      XLSX.utils.sheet_to_json<
        unknown[]
      >(
        sheet,
        {
          header: 1,

          defval:
            "",

          raw:
            false,
        },
      );

    for (
      const row of data
    ) {
      rows.push(
        (
          row as unknown[]
        ).map(
          (
            cell,
          ) =>
            cell == null
              ? ""
              : String(
                  cell,
                ),
        ),
      );
    }
  }

  return rows;
}

/* ------------------------------------------------------------------ *
 * Extraction progress
 * ------------------------------------------------------------------ */

export type ExtractProgress =
  (
    stage: string,
  ) => void;

/* ------------------------------------------------------------------ *
 * Main file reader
 * ------------------------------------------------------------------ */

export async function extractFromFile(
  file: File,
  onProgress?: ExtractProgress,
): Promise<CombinedResult> {
  const name =
    file.name.toLowerCase();

  const isImage =
    file.type.startsWith(
      "image/",
    ) ||
    /\.(jpg|jpeg|png|webp|bmp|tiff?)$/i.test(
      name,
    );

  /* ---------------------------------------------------------------- *
   * IMAGE
   * ---------------------------------------------------------------- */

  if (
    isImage
  ) {
    onProgress?.(
      "Reading scanned image…",
    );

    const image =
      await fileToDataUrl(
        file,
      );

    const text =
      await ocr([
        image,
      ]);

    return fromText(
      text,
    );
  }

  /* ---------------------------------------------------------------- *
   * PDF
   * ---------------------------------------------------------------- */

  if (
    name.endsWith(
      ".pdf",
    ) ||
    file.type ===
      "application/pdf"
  ) {
    onProgress?.(
      "Reading PDF…",
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

    const {
      text,
      sparsePages,
    } =
      await pdfText(
        doc,
      );

    const parts:
      CombinedResult[] = [];

    /*
     * First attempt: native PDF text layer.
     */
    if (
      text
        .replace(
          /\s/g,
          "",
        )
        .length
    ) {
      parts.push(
        fromText(
          text,
        ),
      );
    }

    let ocrPages =
      [...sparsePages];

    /*
     * IMPORTANT FIX:
     *
     * Previously OCR fallback looked only at Credit results.
     *
     * Now OCR is triggered only when BOTH:
     * Credit = 0
     * Debit = 0
     *
     * Therefore debit-only statements are not incorrectly treated as unreadable.
     */
    const first =
      parts[0];

    const noCredit =
      !(
        first
          ?.credit
          .rows
          .length ?? 0
      );

    const noDebit =
      !(
        first
          ?.debit
          .rows
          .length ?? 0
      );

    /*
     * If PDF text exists but parser finds nothing useful,
     * OCR the document as second attempt.
     */
    if (
      !ocrPages.length &&
      noCredit &&
      noDebit
    ) {
      ocrPages =
        Array.from(
          {
            length:
              doc.numPages,
          },
          (
            _,
            index,
          ) =>
            index + 1,
        );
    }

    /*
     * OCR selected pages.
     *
     * Keep a limit so browser doesn't crash on huge statements.
     */
    if (
      ocrPages.length
    ) {
      const pagesToRead =
        ocrPages.slice(
          0,
          12,
        );

      onProgress?.(
        `Running OCR on ${pagesToRead.length} page(s)…`,
      );

      const images:
        string[] = [];

      for (
        const pageNumber of
          pagesToRead
      ) {
        try {
          images.push(
            await pageToDataUrl(
              doc,
              pageNumber,
            ),
          );
        } catch {
          /*
           * One failed page should not kill the whole statement.
           */
        }
      }

      if (
        images.length
      ) {
        const ocrText =
          await ocr(
            images,
          );

        if (
          ocrText.trim()
        ) {
          parts.push(
            fromText(
              ocrText,
            ),
          );
        }
      }
    }

    /*
     * Merge native PDF + OCR results.
     */
    const result =
      mergeCombined(
        parts.length
          ? parts
          : [
              fromText(
                "",
              ),
            ],
      );

    /*
     * PDF successfully opened but nothing useful found.
     *
     * Return empty parser result instead of throwing "Unable to read PDF".
     * UI can correctly display zero transactions.
     */
    return result;
  }

  /* ---------------------------------------------------------------- *
   * XLS / XLSX / CSV
   * ---------------------------------------------------------------- */

  if (
    name.endsWith(
      ".xls",
    ) ||
    name.endsWith(
      ".xlsx",
    ) ||
    name.endsWith(
      ".csv",
    )
  ) {
    onProgress?.(
      "Reading spreadsheet…",
    );

    try {
      const rows =
        await readSheetRows(
          file,
        );

      return fromRows(
        rows,
      );
    } catch {
      throw new Error(
        "Unable to read this spreadsheet file.",
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * TXT / TEXT / OTHER PLAIN TEXT
   * ---------------------------------------------------------------- */

  onProgress?.(
    "Reading text…",
  );

  try {
    const text =
      await file.text();

    return fromText(
      text,
    );
  } catch {
    throw new Error(
      "Unable to read this text file.",
    );
  }
}
